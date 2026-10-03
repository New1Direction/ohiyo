//! Minimal gateway WebSocket client for integration tests, without a WebSocket crate:
//! the HTTP upgrade is written by hand, server frames arrive unmasked, and client
//! frames are sent masked as RFC 6455 requires.

use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::TestServer;

/// Upper bound on any single wait, so a missing event fails the test instead of
/// hanging it. Tests synchronise on a specific event, never on elapsed time.
const WAIT_LIMIT: Duration = Duration::from_secs(10);

pub struct Gateway {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Gateway {
    /// Exchange `token` for a one-time ticket and open `/gateway` with it.
    pub async fn connect(srv: &TestServer, token: &str) -> Self {
        let ticket = Self::issue_ticket(srv, token).await;
        Self::open(srv, &ticket)
            .await
            .unwrap_or_else(|head| panic!("gateway upgrade failed: {head}"))
    }

    /// Exchange `token` for a one-time gateway ticket.
    pub async fn issue_ticket(srv: &TestServer, token: &str) -> String {
        let ticket: Value = srv
            .post_empty_auth("/api/v1/ws/ticket", token)
            .await
            .json()
            .await
            .expect("ticket json");
        ticket["ticket"].as_str().expect("ticket").to_owned()
    }

    /// Open `/gateway` with a ticket. On a refused upgrade, returns the response head.
    pub async fn open(srv: &TestServer, ticket: &str) -> Result<Self, String> {
        let addr = srv.base.trim_start_matches("http://").to_owned();
        let mut stream = TcpStream::connect(&addr).await.expect("connect gateway");
        let request = format!(
            "GET /gateway?ticket={ticket} HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("send upgrade");
        let mut gw = Gateway {
            stream,
            buf: Vec::new(),
        };
        let header_end = loop {
            if let Some(p) = gw.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            gw.read_more().await;
        };
        let head = String::from_utf8_lossy(&gw.buf[..header_end]).to_string();
        if !head.starts_with("HTTP/1.1 101") {
            return Err(head);
        }
        gw.buf.drain(..header_end);
        Ok(gw)
    }

    async fn read_more(&mut self) {
        let mut chunk = [0u8; 65536];
        let n = tokio::time::timeout(WAIT_LIMIT, self.stream.read(&mut chunk))
            .await
            .expect("gateway read timed out")
            .expect("gateway read");
        assert!(n > 0, "gateway closed the connection");
        self.buf.extend_from_slice(&chunk[..n]);
    }

    async fn fill(&mut self, n: usize) {
        while self.buf.len() < n {
            self.read_more().await;
        }
    }

    /// The next text frame, parsed as a JSON gateway event (`{"t": .., "d": ..}`).
    pub async fn next_event(&mut self) -> Value {
        loop {
            self.fill(2).await;
            let opcode = self.buf[0] & 0x0f;
            let (header, len) = match self.buf[1] & 0x7f {
                126 => {
                    self.fill(4).await;
                    (4, u16::from_be_bytes([self.buf[2], self.buf[3]]) as usize)
                }
                127 => {
                    self.fill(10).await;
                    let len = u64::from_be_bytes(self.buf[2..10].try_into().unwrap());
                    (10, len as usize)
                }
                n => (2, n as usize),
            };
            self.fill(header + len).await;
            let payload: Vec<u8> = self.buf.drain(..header + len).skip(header).collect();
            match opcode {
                0x1 => return serde_json::from_slice(&payload).expect("gateway event json"),
                0x8 => panic!("gateway sent a close frame"),
                _ => continue,
            }
        }
    }

    /// Read until the server ends the connection: a close frame, EOF or a reset. Returns
    /// the close code, if a close frame carried one, and the events that arrived first.
    /// Panics if the connection stays open past the wait limit.
    pub async fn wait_closed(&mut self) -> (Option<u16>, Vec<Value>) {
        let mut events = Vec::new();
        let ended = tokio::time::timeout(WAIT_LIMIT, async {
            loop {
                if let Some((opcode, payload)) = self.take_frame() {
                    match opcode {
                        0x1 => events.push(serde_json::from_slice(&payload).expect("event json")),
                        0x8 => return payload.get(..2).map(|c| u16::from_be_bytes([c[0], c[1]])),
                        _ => {}
                    }
                    continue;
                }
                let mut chunk = [0u8; 65536];
                match self.stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                }
            }
        })
        .await
        .expect("gateway did not close the connection");
        (ended, events)
    }

    /// One complete frame (opcode, payload) from what has already arrived, if any.
    fn take_frame(&mut self) -> Option<(u8, Vec<u8>)> {
        let (header, len) = match *self.buf.get(1)? & 0x7f {
            126 => (
                4,
                u16::from_be_bytes([*self.buf.get(2)?, *self.buf.get(3)?]) as usize,
            ),
            127 => {
                let len = u64::from_be_bytes(self.buf.get(2..10)?.try_into().unwrap());
                (10, len as usize)
            }
            n => (2, n as usize),
        };
        if self.buf.len() < header + len {
            return None;
        }
        let opcode = self.buf[0] & 0x0f;
        Some((
            opcode,
            self.buf.drain(..header + len).skip(header).collect(),
        ))
    }

    /// Send one text frame of `len` bytes, ignoring write errors: the server is expected
    /// to drop the connection before it has read the whole frame.
    pub async fn send_oversized(&mut self, len: usize) {
        let _ = self
            .stream
            .write_all(&masked_text_frame(&vec![b' '; len]))
            .await;
    }

    /// Read events until one satisfies `pred`, and return it.
    pub async fn wait_for(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        loop {
            let event = self.next_event().await;
            if pred(&event) {
                return event;
            }
        }
    }

    /// Send a client event as a single masked text frame.
    pub async fn send(&mut self, event: &Value) {
        let payload = serde_json::to_vec(event).expect("encode client event");
        self.stream
            .write_all(&masked_text_frame(&payload))
            .await
            .expect("send frame");
    }
}

/// A complete client text frame: FIN + text opcode, length, mask, masked payload.
fn masked_text_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x81u8];
    match payload.len() {
        n if n < 126 => frame.push(0x80 | n as u8),
        n if n <= 0xffff => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    let mask = [0x5a, 0x17, 0xc3, 0x09];
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    frame
}
