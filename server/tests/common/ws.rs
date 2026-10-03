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
        let ticket: Value = srv
            .post_empty_auth("/api/v1/ws/ticket", token)
            .await
            .json()
            .await
            .expect("ticket json");
        let ticket = ticket["ticket"].as_str().expect("ticket").to_owned();
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
        assert!(
            head.starts_with("HTTP/1.1 101"),
            "gateway upgrade failed: {head}"
        );
        gw.buf.drain(..header_end);
        gw
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
        self.stream.write_all(&frame).await.expect("send frame");
    }
}
