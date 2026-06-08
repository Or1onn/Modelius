// lib.rs — Tauri app entrypoint: wires plugins, the SQLite migration, and the
// command handlers. The commands themselves live in the domain modules below.
mod anthropic;
mod artifacts;
mod openai;
mod stream;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "create chats table",
        sql: "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        kind: tauri_plugin_sql::MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:orchestro.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            anthropic::anthropic_oauth_token,
            anthropic::anthropic_list_models,
            anthropic::anthropic_messages_stream,
            openai::openai_await_callback,
            openai::openai_oauth_token,
            openai::openai_responses_stream,
            artifacts::artifact_write,
            artifacts::artifact_read
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
