use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::{args::ChatOptions, client::Client, monitor::line, output::progress};

const PAGE_SIZE: usize = 10;

pub struct Choice {
    pub id: String,
    pub label: String,
}

impl Choice {
    pub fn plain(id: &str) -> Self {
        Self {
            id: id.into(),
            label: id.into(),
        }
    }
}

fn matching<'a>(choices: &'a [Choice], query: &str) -> Vec<&'a Choice> {
    let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
    choices
        .iter()
        .filter(|choice| {
            let searchable = format!("{} {}", choice.id, choice.label).to_lowercase();
            terms.iter().all(|term| searchable.contains(term))
        })
        .collect()
}

/// Search and page the complete catalog without silently dropping long titles or entries.
pub fn choose(title: &str, choices: &[Choice], current: Option<&str>) -> Result<Option<String>> {
    if choices.is_empty() {
        progress("No available choices.");
        return Ok(None);
    }
    let mut query = String::new();
    let mut page = 0;
    loop {
        let matches = matching(choices, &query);
        let pages = matches.len().div_ceil(PAGE_SIZE).max(1);
        page = page.min(pages - 1);
        progress(&format!(
            "\n{title} · {} match(es) · page {}/{}",
            matches.len(),
            page + 1,
            pages
        ));
        let start = page * PAGE_SIZE;
        let visible = matches
            .iter()
            .skip(start)
            .take(PAGE_SIZE)
            .collect::<Vec<_>>();
        for (index, choice) in visible.iter().enumerate() {
            let marker = if current == Some(choice.id.as_str()) {
                " (current)"
            } else {
                ""
            };
            progress(&format!("  {}. {}{marker}", index + 1, choice.label));
        }
        progress("Enter a number or exact ID to select; type words to search. /n next, /p previous, /clear all, /cancel.");
        let Some(input) = line("Select/search> ")? else {
            return Ok(None);
        };
        let input = input.trim();
        match input {
            "/cancel" => return Ok(None),
            "/n" => page = (page + 1).min(pages - 1),
            "/p" => page = page.saturating_sub(1),
            "/clear" => {
                query.clear();
                page = 0;
            }
            "" => {
                if let Some(choice) =
                    current.and_then(|id| choices.iter().find(|choice| choice.id == id))
                {
                    return Ok(Some(choice.id.clone()));
                }
            }
            _ => {
                if let Some(choice) = choices.iter().find(|choice| choice.id == input) {
                    return Ok(Some(choice.id.clone()));
                }
                if let Some(choice) = input
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| index.checked_sub(1))
                    .and_then(|index| visible.get(index))
                {
                    return Ok(Some(choice.id.clone()));
                }
                query = input.to_owned();
                page = 0;
            }
        }
    }
}

pub fn model_choices(result: &Value) -> Result<Vec<Choice>> {
    result["models"]
        .as_array()
        .context("invalid text model catalog")?
        .iter()
        .map(|model| {
            model
                .as_str()
                .map(Choice::plain)
                .context("invalid text model ID")
        })
        .collect()
}

pub async fn model(client: &mut Client, current: Option<&str>) -> Result<Option<String>> {
    let catalog = client.call("model.list", json!({})).await?;
    choose(
        "Text model — this session only",
        &model_choices(&catalog)?,
        current,
    )
}

pub async fn session(client: &mut Client, options: &ChatOptions) -> Result<Option<String>> {
    let result = crate::sessions::list(client, options, false).await?;
    let mut sessions = result["sessions"]
        .as_array()
        .context("invalid session list")?
        .iter()
        .filter(|session| session["archived"] != true && session["external"].is_null())
        .collect::<Vec<_>>();
    sessions.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    let choices = sessions
        .iter()
        .map(|session| {
            let id = session["id"].as_str().context("session ID missing")?;
            let title = session["title"].as_str().unwrap_or(id);
            let status = session["status"].as_str().unwrap_or("unknown");
            let updated = session["updatedAt"].as_str().unwrap_or("");
            Ok(Choice {
                id: id.into(),
                label: format!("{title} · {status} · {updated}\n     {id}"),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    choose("Resume a session in this project", &choices, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_keeps_all_matches_and_full_titles_across_pages() {
        let choices = (0..31)
            .map(|index| Choice {
                id: format!("id-{index}"),
                label: format!("项目 中文标题 Gemini {index}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(matching(&choices, "GEMINI 中文").len(), 31);
        assert_eq!(
            matching(&choices, "id-30")[0].label,
            "项目 中文标题 Gemini 30"
        );
        assert!(matching(&choices, "unavailable").is_empty());
    }

    #[test]
    fn consumes_daemons_filtered_model_catalog_without_inventing_ids() {
        let choices = model_choices(&json!({"models":["Claude Opus", "gpt-5.6-sol"]})).unwrap();
        assert_eq!(choices[0].id, "Claude Opus");
        assert_eq!(matching(&choices, "claude").len(), 1);
        assert!(model_choices(&json!({"data":[]})).is_err());
    }
}
