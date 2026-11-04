//! Rendering helpers: streaming Markdown, diffs, tool summaries, plans and turn summaries.
//!
//! Every piece of model/tool/file text passes through `terminal_text` before styling.

use serde_json::Value;

use crate::output::terminal_text;

#[derive(Debug, Clone, Copy)]
pub struct Style {
    pub color: bool,
}

impl Style {
    pub fn detect() -> Self {
        let color = std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
            && std::env::var("TERM").map_or(true, |t| t != "dumb");
        Self { color }
    }

    #[cfg(test)]
    pub fn plain() -> Self {
        Self { color: false }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.color && !text.is_empty() {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }
    pub fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }
    pub fn italic(&self, text: &str) -> String {
        self.paint("3", text)
    }
    pub fn red(&self, text: &str) -> String {
        self.paint("31", text)
    }
    pub fn green(&self, text: &str) -> String {
        self.paint("32", text)
    }
    pub fn yellow(&self, text: &str) -> String {
        self.paint("33", text)
    }
    pub fn cyan(&self, text: &str) -> String {
        self.paint("36", text)
    }
    pub fn magenta(&self, text: &str) -> String {
        self.paint("35", text)
    }
}

/// Line-buffered Markdown renderer for streaming assistant deltas.
#[derive(Debug, Default)]
pub struct Markdown {
    pending: String,
    fence: Option<String>,
}

impl Markdown {
    /// Feed a delta, returning fully rendered lines (each ending with `\n`).
    pub fn push(&mut self, delta: &str, style: Style) -> String {
        self.pending.push_str(delta);
        let mut out = String::new();
        while let Some(index) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=index).collect();
            out.push_str(&self.line(line.trim_end_matches('\n'), style));
            out.push('\n');
        }
        out
    }

    /// Flush any partial line at the end of a message.
    pub fn finish(&mut self, style: Style) -> String {
        let rest = std::mem::take(&mut self.pending);
        let result = if rest.is_empty() {
            String::new()
        } else {
            format!("{}\n", self.line(&rest, style))
        };
        self.fence = None;
        result
    }

    fn line(&mut self, raw: &str, style: Style) -> String {
        let line = terminal_text(raw);
        let trimmed = line.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            if self.fence.is_some() {
                self.fence = None;
                return style.dim("└──");
            }
            self.fence = Some(info.trim().to_string());
            let label = if info.trim().is_empty() {
                "┌──".to_string()
            } else {
                format!("┌── {}", info.trim())
            };
            return style.dim(&label);
        }
        if let Some(lang) = &self.fence {
            let body = if lang == "diff" || lang == "patch" {
                diff_line(&line, style)
            } else {
                style.cyan(&line)
            };
            return format!("{} {body}", style.dim("│"));
        }
        render_block(&line, style)
    }
}

fn render_block(line: &str, style: Style) -> String {
    let indent = line.len() - line.trim_start().len();
    let trimmed = line.trim_start();
    let pad = &line[..indent];
    if let Some(level) = heading(trimmed) {
        let text = trimmed[level..].trim();
        return style.bold(&if level == 1 {
            text.to_uppercase()
        } else {
            text.to_string()
        });
    }
    if let Some(rest) = trimmed
        .strip_prefix("> ")
        .or(trimmed.strip_prefix('>').filter(|r| r.is_empty()))
    {
        return format!(
            "{pad}{} {}",
            style.dim("▌"),
            style.italic(&inline(rest, style))
        );
    }
    if let Some(rest) = trimmed
        .strip_prefix("- [ ] ")
        .map(|r| ("☐", r))
        .or_else(|| trimmed.strip_prefix("- [x] ").map(|r| ("☑", r)))
    {
        return format!("{pad}{} {}", rest.0, inline(rest.1, style));
    }
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return format!("{pad}• {}", inline(rest, style));
    }
    if trimmed == "---" || trimmed == "***" {
        return style.dim(&"─".repeat(40));
    }
    format!("{pad}{}", inline(trimmed, style))
}

fn heading(line: &str) -> Option<usize> {
    let level = line.chars().take_while(|c| *c == '#').count();
    (1..=6)
        .contains(&level)
        .then_some(level)
        .filter(|l| line[*l..].starts_with(' '))
}

/// Inline Markdown: `code`, **bold**, *italic* / _italic_.
pub fn inline(text: &str, style: Style) -> String {
    let mut out = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('`') {
            if let Some(end) = after.find('`') {
                out.push_str(&style.cyan(&after[..end]));
                rest = &after[end + 1..];
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix("**") {
            if let Some(end) = after.find("**").filter(|e| *e > 0) {
                out.push_str(&style.bold(&after[..end]));
                rest = &after[end + 2..];
                continue;
            }
        }
        if let Some(after) = rest.strip_prefix('*') {
            if let Some(end) = after
                .find('*')
                .filter(|e| *e > 0 && !after.starts_with(' '))
            {
                out.push_str(&style.italic(&after[..end]));
                rest = &after[end + 1..];
                continue;
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

pub fn diff_line(line: &str, style: Style) -> String {
    if line.starts_with("+++") || line.starts_with("---") {
        style.bold(line)
    } else if line.starts_with('+') {
        style.green(line)
    } else if line.starts_with('-') {
        style.red(line)
    } else if line.starts_with("@@") {
        style.magenta(line)
    } else {
        line.to_string()
    }
}

/// Render the result of `session.diff`.
pub fn diff(result: &Value, style: Style) -> String {
    let files = result
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if files.is_empty() {
        return "No changes in this session.\n".to_string();
    }
    let mut out = String::new();
    for file in &files {
        let path = terminal_text(file.get("path").and_then(Value::as_str).unwrap_or("?"));
        let add = file.get("additions").and_then(Value::as_u64).unwrap_or(0);
        let del = file.get("deletions").and_then(Value::as_u64).unwrap_or(0);
        out.push_str(&format!(
            "{} {} {}\n",
            style.bold(&path),
            style.green(&format!("+{add}")),
            style.red(&format!("-{del}"))
        ));
        for hunk in file
            .get("hunks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(header) = hunk.get("header").and_then(Value::as_str) {
                out.push_str(&style.magenta(&terminal_text(header)));
                out.push('\n');
            } else {
                out.push_str(&style.magenta("@@"));
                out.push('\n');
            }
            for line in hunk
                .get("lines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let content =
                    terminal_text(line.get("content").and_then(Value::as_str).unwrap_or(""));
                let content = content.trim_end_matches('\n');
                let text = match line.get("kind").and_then(Value::as_str) {
                    Some("addition") => style.green(&format!("+{content}")),
                    Some("deletion") => style.red(&format!("-{content}")),
                    _ => format!(" {content}"),
                };
                out.push_str(&text);
                out.push('\n');
            }
        }
    }
    out
}

/// One-line description of a tool call, e.g. `Ran shell: ls -la`.
fn tool_detail(input: &Value) -> String {
    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| input.get(*k).and_then(Value::as_str))
            .map(|s| s.to_string())
    };
    let detail = field(&[
        "command",
        "cmd",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "prompt",
    ])
    .or_else(|| {
        input.get("commands").and_then(Value::as_array).map(|c| {
            c.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ")
        })
    })
    .unwrap_or_else(|| {
        if input.is_null() {
            String::new()
        } else {
            input.to_string()
        }
    });
    terminal_text(&detail).replace('\n', " ⏎ ")
}

pub fn tool_summary(name: &str, input: &Value) -> String {
    let detail = tool_detail(input);
    let lower = name.to_ascii_lowercase();
    let verb = if lower.contains("shell") || lower.contains("bash") || lower.contains("exec") {
        "Ran"
    } else if lower.contains("read") || lower.contains("view") {
        "Read"
    } else if lower.contains("write")
        || lower.contains("edit")
        || lower.contains("patch")
        || lower.contains("replace")
    {
        "Edited"
    } else if lower.contains("search")
        || lower.contains("grep")
        || lower.contains("glob")
        || lower.contains("find")
    {
        "Searched"
    } else {
        "Called"
    };
    let name = terminal_text(name);
    if detail.is_empty() {
        format!("{verb} {name}")
    } else {
        format!("{verb} {name}: {detail}")
    }
}

/// Completion status and complete output; the transcript handles folding/scrolling.
pub fn tool_finished(status: &str, output: Option<&Value>, style: Style) -> String {
    let ok = matches!(status, "completed" | "succeeded" | "success" | "ok");
    let mark = if ok {
        style.green("✓")
    } else {
        style.red(&format!("✗ {}", terminal_text(status)))
    };
    let text = match output {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string_pretty(value).expect("JSON value is serializable"),
    };
    let text = terminal_text(&text);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("  {mark}");
    if lines.is_empty() {
        out.push('\n');
        return out;
    }
    out.push('\n');
    for line in &lines {
        out.push_str(&format!("  {} {}\n", style.dim("│"), style.dim(line)));
    }
    out
}

pub fn plan(tasks: &Value, style: Style) -> String {
    let mut out = String::new();
    for task in tasks.as_array().into_iter().flatten() {
        let text = task
            .get("content")
            .or_else(|| task.get("title"))
            .or_else(|| task.get("subject"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let text = terminal_text(text);
        let line = match task.get("status").and_then(Value::as_str) {
            Some("completed" | "done") => format!("  {} {}", style.green("☑"), style.dim(&text)),
            Some("in_progress" | "inProgress" | "running") => {
                format!("  {} {}", style.yellow("◐"), style.bold(&text))
            }
            _ => format!("  ☐ {text}"),
        };
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub fn turn_summary(summary: Option<&Value>, elapsed: std::time::Duration, style: Style) -> String {
    let get = |k: &str| summary.and_then(|s| s.get(k)).and_then(Value::as_u64);
    let millis = get("durationMs").unwrap_or(elapsed.as_millis() as u64);
    let mut parts = vec![duration(millis)];
    if let Some(tools) = get("toolCalls") {
        let failed = get("failedToolCalls").unwrap_or(0);
        if failed > 0 {
            parts.push(format!("{tools} tools ({failed} failed)"));
        } else {
            parts.push(format!("{tools} tools"));
        }
    }
    if let Some(files) = summary.and_then(|s| s.get("filesChanged")) {
        let count = files
            .as_u64()
            .or_else(|| files.as_array().map(|a| a.len() as u64))
            .unwrap_or(0);
        if count > 0 {
            parts.push(format!("{count} files changed"));
        }
    }
    format!("{}\n", style.dim(&format!("─ {} ─", parts.join(" · "))))
}

pub fn duration(millis: u64) -> String {
    let secs = millis / 1000;
    if secs >= 60 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else if millis >= 1000 {
        format!("{:.1}s", millis as f64 / 1000.0)
    } else {
        format!("{millis}ms")
    }
}

#[cfg(test)]
#[path = "render_tests.rs"]
mod tests;
