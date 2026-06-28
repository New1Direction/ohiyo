//! Discord Server Template ingestion.
//!
//! A template link is the lowest-friction migration path: no archive upload and no
//! admins rebuilding categories/channels/roles by hand. Discord's template payload is
//! converted into the stable `SourceGuild` model used by the importer.

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use url::Url;

use super::model::{
    SourceCategory, SourceChannel, SourceEmoji, SourceGuild, SourcePermissionOverwrite, SourceRole,
};

pub async fn fetch_template_source(input: &str) -> Result<SourceGuild> {
    let code = template_code(input).context("Discord template code not found")?;
    let url = format!("https://discord.com/api/v10/guilds/templates/{code}");
    let value: Value = reqwest::Client::new()
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    source_guild_from_template_value(&code, &value)
}

pub fn template_code(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('/') && !trimmed.contains('?') && !trimmed.contains('#') {
        return Some(trimmed.to_owned());
    }
    let parsed = Url::parse(trimmed).ok()?;
    let segments: Vec<_> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();
    if parsed.domain().is_some_and(|d| d == "discord.new") {
        return segments.first().map(|s| (*s).to_owned());
    }
    for marker in ["template", "templates"] {
        if let Some(pos) = segments.iter().position(|s| *s == marker) {
            if let Some(code) = segments.get(pos + 1) {
                return Some((*code).to_owned());
            }
        }
    }
    segments.last().map(|s| (*s).to_owned())
}

pub fn source_guild_from_template_value(code: &str, value: &Value) -> Result<SourceGuild> {
    let source = value
        .get("serialized_source_guild")
        .or_else(|| value.get("serializedSourceGuild"))
        .unwrap_or(value);
    let source_guild_id = value
        .get("source_guild_id")
        .or_else(|| value.get("sourceGuildId"))
        .and_then(Value::as_str)
        .or_else(|| source.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("template:{code}"));
    let guild_name = source
        .get("name")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Imported Discord template")
        .to_owned();

    let roles = parse_roles(source);
    let role_names: HashMap<String, String> = roles
        .iter()
        .map(|role| (role.discord_id.clone(), role.name.clone()))
        .collect();
    let categories = parse_categories(source);
    let channels = parse_channels(source, &role_names);
    let emojis = parse_emojis(source);

    Ok(SourceGuild {
        discord_id: source_guild_id.clone(),
        name: guild_name,
        icon_url: icon_url(value, source, &source_guild_id),
        authors: vec![],
        roles,
        emojis,
        categories,
        channels,
    })
}

fn parse_roles(source: &Value) -> Vec<SourceRole> {
    source
        .get("roles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|role| {
            let id = str_or_number(role.get("id"))?;
            let name = role.get("name").and_then(Value::as_str).unwrap_or("role");
            Some(SourceRole {
                discord_id: id,
                name: name.to_owned(),
                color: color_hex(role.get("color")),
                permissions: str_or_number(role.get("permissions")),
                position: role.get("position").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

fn parse_categories(source: &Value) -> Vec<SourceCategory> {
    source
        .get("channels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|ch| ch.get("type").and_then(Value::as_i64) == Some(4))
        .filter_map(|ch| {
            Some(SourceCategory {
                discord_id: str_or_number(ch.get("id"))?,
                name: ch
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Category")
                    .to_owned(),
                position: ch.get("position").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

fn parse_channels(source: &Value, role_names: &HashMap<String, String>) -> Vec<SourceChannel> {
    source
        .get("channels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|ch| ch.get("type").and_then(Value::as_i64) != Some(4))
        .filter_map(|ch| {
            let id = str_or_number(ch.get("id"))?;
            let ty = ch.get("type").and_then(Value::as_i64).unwrap_or(0);
            Some(SourceChannel {
                discord_id: id,
                name: ch
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("channel")
                    .to_owned(),
                kind: if ty == 2 { "voice" } else { "text" }.to_owned(),
                topic: ch
                    .get("topic")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned),
                position: ch.get("position").and_then(Value::as_i64).unwrap_or(0),
                category_discord_id: str_or_number(ch.get("parent_id")),
                permission_overwrites: parse_overwrites(ch, role_names),
                messages: vec![],
            })
        })
        .collect()
}

fn parse_overwrites(
    ch: &Value,
    role_names: &HashMap<String, String>,
) -> Vec<SourcePermissionOverwrite> {
    ch.get("permission_overwrites")
        .or_else(|| ch.get("permissionOverwrites"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|ow| {
            let target_discord_id = str_or_number(ow.get("id"))?;
            let target_type = match ow.get("type").and_then(Value::as_i64) {
                Some(0) => "role",
                Some(1) => "member",
                _ => ow.get("type").and_then(Value::as_str).unwrap_or("unknown"),
            }
            .to_owned();
            Some(SourcePermissionOverwrite {
                target_name: role_names.get(&target_discord_id).cloned(),
                target_discord_id,
                target_type,
                allow: str_or_number(ow.get("allow")).unwrap_or_else(|| "0".to_owned()),
                deny: str_or_number(ow.get("deny")).unwrap_or_else(|| "0".to_owned()),
            })
        })
        .collect()
}

fn parse_emojis(source: &Value) -> Vec<SourceEmoji> {
    source
        .get("emojis")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|emoji| {
            let id = str_or_number(emoji.get("id"))?;
            let name = emoji
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("emoji")
                .to_owned();
            let animated = emoji
                .get("animated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let ext = if animated { "gif" } else { "png" };
            let image_url = emoji
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    Some(format!(
                        "https://cdn.discordapp.com/emojis/{id}.{ext}?size=96&quality=lossless"
                    ))
                });
            Some(SourceEmoji {
                discord_id: id,
                name,
                image_url,
                animated,
            })
        })
        .collect()
}

fn icon_url(template: &Value, source: &Value, guild_id: &str) -> Option<String> {
    for key in ["icon", "icon_url", "iconUrl"] {
        if let Some(raw) = source
            .get(key)
            .or_else(|| template.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            if raw.starts_with("http") {
                return Some(raw.to_owned());
            }
            return Some(format!(
                "https://cdn.discordapp.com/icons/{guild_id}/{raw}.png?size=256"
            ));
        }
    }
    let hash = source
        .get("icon_hash")
        .or_else(|| source.get("iconHash"))
        .or_else(|| template.get("icon_hash"))
        .or_else(|| template.get("iconHash"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())?;
    Some(format!(
        "https://cdn.discordapp.com/icons/{guild_id}/{hash}.png?size=256"
    ))
}

fn color_hex(value: Option<&Value>) -> Option<String> {
    let n = value.and_then(Value::as_i64).unwrap_or(0);
    if n <= 0 {
        None
    } else {
        Some(format!("#{:06x}", n & 0x00ff_ffff))
    }
}

fn str_or_number(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(s) = value.as_str() {
        return Some(s.to_owned());
    }
    if let Some(n) = value.as_i64() {
        return Some(n.to_string());
    }
    if let Some(n) = value.as_u64() {
        return Some(n.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_template_codes_from_common_links() {
        assert_eq!(template_code("abc123").as_deref(), Some("abc123"));
        assert_eq!(
            template_code("https://discord.new/abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            template_code("https://discord.com/template/abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            template_code("https://discord.com/guilds/templates/abc123?x=1").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn maps_template_structure_roles_and_overwrites() {
        let json = serde_json::json!({
            "code": "tpl",
            "source_guild_id": "guild1",
            "serialized_source_guild": {
                "name": "Launch Crew",
                "icon_hash": "hashy",
                "roles": [
                    {"id":"guild1", "name":"@everyone", "permissions":"1024", "position":0, "color":0},
                    {"id":"r1", "name":"Mods", "permissions":"268435472", "position":3, "color":16711935}
                ],
                "channels": [
                    {"id":"cat1", "type":4, "name":"Info", "position":0},
                    {"id":"ch1", "type":0, "name":"welcome", "position":1, "parent_id":"cat1", "topic":"start here", "permission_overwrites":[
                        {"id":"r1", "type":0, "allow":"1024", "deny":"2048"}
                    ]},
                    {"id":"v1", "type":2, "name":"Lounge", "position":2, "parent_id":"cat1"}
                ],
                "emojis": [{"id":"e1", "name":"kikka", "animated": false}]
            }
        });
        let guild = source_guild_from_template_value("tpl", &json).unwrap();
        assert_eq!(guild.name, "Launch Crew");
        assert_eq!(
            guild.icon_url.as_deref(),
            Some("https://cdn.discordapp.com/icons/guild1/hashy.png?size=256")
        );
        assert_eq!(guild.roles.len(), 2);
        assert_eq!(guild.roles[1].color.as_deref(), Some("#ff00ff"));
        assert_eq!(guild.categories[0].name, "Info");
        assert_eq!(guild.channels.len(), 2);
        assert_eq!(
            guild.channels[0].category_discord_id.as_deref(),
            Some("cat1")
        );
        assert_eq!(
            guild.channels[0].permission_overwrites[0]
                .target_name
                .as_deref(),
            Some("Mods")
        );
        assert_eq!(guild.channels[1].kind, "voice");
        assert_eq!(
            guild.emojis[0].image_url.as_deref(),
            Some("https://cdn.discordapp.com/emojis/e1.png?size=96&quality=lossless")
        );
    }
}
