//! S-M12: columns looked up when a message or user goes need an index that leads with
//! them, or every delete scans the whole table.

mod common;

use common::TestServer;

#[tokio::test]
async fn message_reference_columns_are_indexed() {
    let srv = TestServer::start().await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    for (table, column) in [
        ("messages", "reply_to"),
        ("messages", "author_id"),
        ("hidden_messages", "message_id"),
        ("saved_messages", "message_id"),
        ("abuse_reports", "message_id"),
    ] {
        let leading: Vec<String> = sqlx::query_scalar(
            "SELECT il.name FROM pragma_index_list(?1) il
             JOIN pragma_index_info(il.name) ii
             WHERE ii.seqno = 0 AND ii.name = ?2",
        )
        .bind(table)
        .bind(column)
        .fetch_all(&db)
        .await
        .unwrap();
        assert!(
            !leading.is_empty(),
            "no index on {table} leads with {column}"
        );
    }
}
