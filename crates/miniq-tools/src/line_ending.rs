//! Line-ending model shared by every text-editing tool.
//!
//! Models always see LF. Files on disk may be LF, CRLF, CR-only or mixed.
//! If reading and matching disagree about which representation they work in,
//! an exact-match edit silently stops matching a CRLF target: the read path
//! strips `\r`, the match path compares raw bytes. This module removes that
//! split by owning both directions:
//!
//! * [`to_lf`] produces the view the model reads.
//! * [`restore`] rebuilds the edited view using the original endings, so a
//!   CRLF file stays CRLF and a mixed file keeps untouched lines untouched.
//!
//! [`Document`] carries the richer per-line form used by `apply_patch`, which
//! rewrites arbitrary line ranges instead of doing a string search.

/// The terminator that followed a single line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineEnding {
    Lf,
    CrLf,
    Cr,
}

impl LineEnding {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
            Self::Cr => "\r",
        }
    }

    /// Short label used in tool output, e.g. `"crlf"`.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Lf => "lf",
            Self::CrLf => "crlf",
            Self::Cr => "cr",
        }
    }
}

/// A text file split into logical lines, keeping each line's terminator.
///
/// `endings[i]` is `None` only for a final line that has no terminator. The
/// first terminator seen becomes `preferred` and is used for inserted lines,
/// matching the convention every popular patch tool uses.
pub(crate) struct Document {
    pub(crate) lines: Vec<String>,
    pub(crate) endings: Vec<Option<LineEnding>>,
    pub(crate) preferred: LineEnding,
}

/// Splits `text` into lines plus terminators. Byte indices are safe because
/// `\r` and `\n` are ASCII, so a split can never land inside a multi-byte
/// character.
pub(crate) fn parse(text: &str) -> Document {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut endings = Vec::new();
    let mut preferred = None;
    let mut start = 0;
    let mut cursor = 0;
    while cursor < bytes.len() {
        let (ending, length) = match bytes[cursor] {
            b'\r' if bytes.get(cursor + 1) == Some(&b'\n') => (LineEnding::CrLf, 2),
            b'\r' => (LineEnding::Cr, 1),
            b'\n' => (LineEnding::Lf, 1),
            _ => {
                cursor += 1;
                continue;
            }
        };
        preferred.get_or_insert(ending);
        lines.push(text[start..cursor].to_string());
        endings.push(Some(ending));
        cursor += length;
        start = cursor;
    }
    if start < bytes.len() {
        lines.push(text[start..].to_string());
        endings.push(None);
    }
    Document {
        lines,
        endings,
        preferred: preferred.unwrap_or(LineEnding::Lf),
    }
}

impl Document {
    /// Replaces `remove` lines at `at` with `insert`, ending new lines with the
    /// document's preferred terminator. Out-of-range positions clamp instead of
    /// panicking, so a bad hunk position cannot abort a patch mid-way.
    pub(crate) fn splice(&mut self, at: usize, remove: usize, insert: Vec<String>) {
        let at = at.min(self.lines.len());
        let remove = remove.min(self.lines.len() - at);
        let inserted = insert.len();
        self.lines.splice(at..at + remove, insert);
        self.endings.splice(
            at..at + remove,
            std::iter::repeat(Some(self.preferred)).take(inserted),
        );
    }

    /// Renders the document back to text. `trailing` controls whether the last
    /// line keeps a terminator.
    pub(crate) fn render(&self, trailing: bool) -> String {
        let mut output = String::new();
        for (index, line) in self.lines.iter().enumerate() {
            output.push_str(line);
            let last = index + 1 == self.lines.len();
            let ending = if last && !trailing {
                None
            } else {
                self.endings
                    .get(index)
                    .copied()
                    .flatten()
                    .or(Some(self.preferred))
            };
            if let Some(ending) = ending {
                output.push_str(ending.as_str());
            }
        }
        output
    }
}

/// The LF-only view handed to the model.
pub(crate) fn to_lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Rebuilds `edited` (an LF view derived from `original`) using the original
/// file's terminators.
///
/// Lines that survived unchanged on either side of the edit keep their exact
/// original terminator; rewritten lines use the file's preferred terminator.
/// This keeps a CRLF file CRLF and leaves untouched lines of a mixed-ending
/// file byte-identical, so a one-line edit no longer rewrites the whole file.
pub(crate) fn restore(original: &str, edited: &str) -> String {
    if !original.contains('\r') {
        // Pure LF: the edited view is already byte-identical to the target.
        return edited.to_string();
    }
    let source = parse(original);
    let preferred = source.preferred;

    let trailing = edited.ends_with('\n');
    let mut new_lines: Vec<&str> = edited.split('\n').collect();
    if trailing {
        new_lines.pop();
    }

    let source_len = source.lines.len();
    let new_len = new_lines.len();

    let mut prefix = 0;
    while prefix < source_len && prefix < new_len && source.lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix + prefix < source_len
        && suffix + prefix < new_len
        && source.lines[source_len - 1 - suffix] == new_lines[new_len - 1 - suffix]
    {
        suffix += 1;
    }

    let mut output = String::new();
    for (index, line) in new_lines.iter().enumerate() {
        output.push_str(line);
        let last = index + 1 == new_len;
        if last && !trailing {
            break;
        }
        // A line may inherit its original terminator only when its text is
        // unchanged. Common prefix and suffix always align; when the edit kept
        // the line count, the remaining lines align index-for-index too, which
        // covers the usual "one line changed in the middle" case.
        let source_index = if index < prefix {
            Some(index)
        } else if index + suffix >= new_len {
            Some(source_len - (new_len - index))
        } else if source_len == new_len {
            Some(index)
        } else {
            None
        };
        let ending = source_index
            .filter(|&source_index| {
                source.lines.get(source_index).map(String::as_str) == Some(*line)
            })
            .and_then(|source_index| source.endings.get(source_index).copied().flatten())
            .unwrap_or(preferred);
        output.push_str(ending.as_str());
    }
    output
}

/// Describes a file's terminators for tool output and error messages:
/// `"lf"`, `"crlf"`, `"cr"`, or `"mixed"`. An empty file reports `"lf"`.
pub(crate) fn summary(text: &str) -> &'static str {
    let document = parse(text);
    let mut endings = document.endings.iter().flatten().copied();
    let Some(first) = endings.next() else {
        return LineEnding::Lf.label();
    };
    if endings.all(|ending| ending == first) {
        first.label()
    } else {
        "mixed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_keeps_each_terminator() {
        let document = parse("a\r\nb\nc\r");
        assert_eq!(document.lines, ["a", "b", "c"]);
        assert_eq!(
            document.endings,
            [Some(LineEnding::CrLf), Some(LineEnding::Lf), Some(LineEnding::Cr)]
        );
        assert_eq!(document.preferred, LineEnding::CrLf);
    }

    #[test]
    fn parse_tracks_an_unterminated_last_line() {
        let document = parse("a\nb");
        assert_eq!(document.lines, ["a", "b"]);
        assert_eq!(document.endings, [Some(LineEnding::Lf), None]);
    }

    #[test]
    fn parse_handles_empty_input() {
        let document = parse("");
        assert!(document.lines.is_empty());
        assert_eq!(document.preferred, LineEnding::Lf);
        assert_eq!(summary(""), "lf");
    }

    #[test]
    fn to_lf_normalises_every_terminator() {
        assert_eq!(to_lf("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert_eq!(to_lf("plain\n"), "plain\n");
    }

    #[test]
    fn summary_reports_the_dominant_style() {
        assert_eq!(summary("a\nb\n"), "lf");
        assert_eq!(summary("a\r\nb\r\n"), "crlf");
        assert_eq!(summary("a\rb\r"), "cr");
        assert_eq!(summary("a\r\nb\n"), "mixed");
    }

    #[test]
    fn restore_is_a_no_op_for_pure_lf_files() {
        let original = "hello world\ngoodbye world";
        let edited = "hi world\ngoodbye world";
        assert_eq!(restore(original, edited), edited);
    }

    #[test]
    fn restore_keeps_crlf_after_a_single_line_edit() {
        let original = "a\r\nb\r\n";
        let edited = to_lf(original).replace("b", "B");
        assert_eq!(restore(original, &edited), "a\r\nB\r\n");
    }

    #[test]
    fn restore_keeps_untouched_lines_of_a_mixed_file() {
        let original = "a\r\nb\nc\r\n";
        let edited = to_lf(original).replace("\nb\n", "\nB\n");
        // The rewritten line takes the preferred ending; a and c keep theirs.
        assert_eq!(restore(original, &edited), "a\r\nB\r\nc\r\n");
    }

    #[test]
    fn restore_keeps_an_untouched_cr_line() {
        // Only the first line changes. The untouched CR line keeps "\r" and
        // the untouched CRLF line keeps "\r\n"; the new first line falls back
        // to the file's preferred ending.
        let original = "a\r\nb\rc\r\n";
        let edited = to_lf(original).replacen("a\n", "A\n", 1);
        assert_eq!(restore(original, &edited), "A\r\nb\rc\r\n");
    }

    #[test]
    fn restore_preserves_a_missing_trailing_newline() {
        let original = "a\r\nb";
        let edited = to_lf(original).replace("b", "B");
        assert_eq!(restore(original, &edited), "a\r\nB");
    }

    #[test]
    fn restore_handles_inserted_and_removed_lines() {
        let original = "one\r\ntwo\r\nthree\r\n";
        // Insert a fourth line: it takes the file's preferred ending.
        assert_eq!(
            restore(original, "one\ntwo\nthree\nfour\n"),
            "one\r\ntwo\r\nthree\r\nfour\r\n"
        );
        // Remove the middle line: the survivors keep their terminators.
        assert_eq!(restore(original, "one\nthree\n"), "one\r\nthree\r\n");
    }

    #[test]
    fn document_renders_without_a_trailing_newline() {
        let mut document = parse("a\r\nb\r\n");
        document.splice(1, 1, vec!["B".to_string()]);
        assert_eq!(document.render(true), "a\r\nB\r\n");
        assert_eq!(document.render(false), "a\r\nB");
    }

    #[test]
    fn document_splice_clamps_out_of_range_positions() {
        let mut document = parse("a\n");
        document.splice(99, 5, vec!["b".to_string()]);
        assert_eq!(document.render(true), "a\nb\n");
    }
}
