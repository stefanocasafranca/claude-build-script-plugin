/**
 * paragraph-diff.js — Sentence-level paragraph diffing for build_script v7.0.0
 *
 * Extracts the "Prompts Up to date with Output" paragraph from BUILD_SCRIPT.md
 * and computes sentence-level diffs to understand what requirements changed.
 */

'use strict';

// ---------------------------------------------------------------------------
// Sentence Splitting
// ---------------------------------------------------------------------------

/**
 * Split a paragraph into sentences. Handles:
 * - Period + space delimiter
 * - Period at end of string
 * - Avoids splitting on abbreviations (Mr., Dr., etc.)
 * - Preserves sentence content without trailing periods
 */
function splitSentences(paragraph) {
  if (!paragraph || !paragraph.trim()) return [];

  const text = paragraph.trim();

  // Split on period followed by space or end-of-string, but not on common abbreviations
  const abbrevPattern = /(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e))\.\s+/g;

  const sentences = [];
  let lastIndex = 0;
  let match;

  while ((match = abbrevPattern.exec(text)) !== null) {
    const sentence = text.substring(lastIndex, match.index).trim();
    if (sentence) sentences.push(sentence);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last split
  const remaining = text.substring(lastIndex).trim().replace(/\.$/, '');
  if (remaining) sentences.push(remaining);

  return sentences;
}

// ---------------------------------------------------------------------------
// Levenshtein Distance (for similarity scoring)
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}

// ---------------------------------------------------------------------------
// LCS-based Sentence Alignment
// ---------------------------------------------------------------------------

/**
 * Compute longest common subsequence of sentences using similarity threshold.
 * Two sentences are considered "the same" if similarity > 0.8.
 */
function lcsAlign(oldSentences, newSentences, threshold) {
  threshold = threshold || 0.8;
  const m = oldSentences.length;
  const n = newSentences.length;

  // Build similarity matrix
  const sim = Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      similarity(oldSentences[i], newSentences[j])
    )
  );

  // LCS DP
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sim[i - 1][j - 1] >= threshold) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matched pairs
  const matches = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (sim[i - 1][j - 1] >= threshold && dp[i][j] === dp[i - 1][j - 1] + 1) {
      matches.unshift({ oldIdx: i - 1, newIdx: j - 1, sim: sim[i - 1][j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Paragraph Diffing
// ---------------------------------------------------------------------------

/**
 * Compute sentence-level diff between two paragraphs.
 *
 * Returns:
 *   {
 *     added: string[],      // New sentences not in old
 *     removed: string[],    // Old sentences not in new
 *     modified: { old: string, new: string }[],  // Changed sentences
 *     unchanged: string[],  // Identical sentences
 *     summary: string       // Human-readable summary
 *   }
 */
function diffParagraphs(oldParagraph, newParagraph) {
  const oldSentences = splitSentences(oldParagraph);
  const newSentences = splitSentences(newParagraph);

  if (!oldSentences.length && !newSentences.length) {
    return { added: [], removed: [], modified: [], unchanged: [], summary: 'No changes' };
  }

  if (!oldSentences.length) {
    return {
      added: newSentences,
      removed: [],
      modified: [],
      unchanged: [],
      summary: `${newSentences.length} sentence(s) added (initial content)`,
    };
  }

  if (!newSentences.length) {
    return {
      added: [],
      removed: oldSentences,
      modified: [],
      unchanged: [],
      summary: `${oldSentences.length} sentence(s) removed (content cleared)`,
    };
  }

  // LCS alignment with 0.8 threshold
  const matches = lcsAlign(oldSentences, newSentences, 0.8);

  const matchedOld = new Set(matches.map((m) => m.oldIdx));
  const matchedNew = new Set(matches.map((m) => m.newIdx));

  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];

  // Unmatched old sentences = removed
  for (let i = 0; i < oldSentences.length; i++) {
    if (!matchedOld.has(i)) {
      removed.push(oldSentences[i]);
    }
  }

  // Unmatched new sentences = added
  for (let j = 0; j < newSentences.length; j++) {
    if (!matchedNew.has(j)) {
      added.push(newSentences[j]);
    }
  }

  // Matched sentences: identical = unchanged, different = modified
  for (const m of matches) {
    const oldS = oldSentences[m.oldIdx];
    const newS = newSentences[m.newIdx];
    if (oldS.toLowerCase().trim() === newS.toLowerCase().trim()) {
      unchanged.push(newS);
    } else {
      modified.push({ old: oldS, new: newS });
    }
  }

  // Build summary
  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (modified.length) parts.push(`${modified.length} modified`);
  const summary = parts.length ? parts.join(', ') : 'No meaningful changes';

  return { added, removed, modified, unchanged, summary };
}

// ---------------------------------------------------------------------------
// Paragraph Extraction from BUILD_SCRIPT.md
// ---------------------------------------------------------------------------

/**
 * Extract the "Prompts Up to date with Output" paragraph from BUILD_SCRIPT.md content.
 * Handles both the new continuous paragraph format (v5.0) and the old enumerated format (v4.0).
 */
function extractParagraph(buildScriptContent) {
  if (!buildScriptContent) return '';

  const lines = buildScriptContent.split('\n');
  let inSection = false;
  const contentLines = [];

  for (const line of lines) {
    // Detect section header (various formats)
    if (/prompts?\s+up\s+to\s+date/i.test(line)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Stop at next section (## heading, --- divider, or blank line followed by heading)
      if (/^#{1,3}\s/.test(line) || /^---/.test(line)) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      // Also stop at known section labels that appear as plain text (Google Docs read-back
      // strips ## markers, so these headings arrive without markdown formatting)
      const PLAIN_TEXT_STOPS = /^(How to Run|Tech Stack|Key Files|Project Name|Features|Commands|Overview|Getting Started|Project)\b/i;
      if (PLAIN_TEXT_STOPS.test(trimmed)) break;

      // Handle old enumerated format: strip numbering, skip strikethrough
      if (/^\d+\.\s/.test(trimmed) || /^-\s/.test(trimmed)) {
        let cleaned = trimmed.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '');
        // Skip fully struck-through entries
        if (/^~~.*~~$/.test(cleaned)) continue;
        // Remove quotes
        cleaned = cleaned.replace(/^["']|["']$/g, '');
        if (cleaned) contentLines.push(cleaned);
      } else {
        // New paragraph format: just collect lines
        contentLines.push(trimmed);
      }
    }
  }

  return contentLines.join(' ').trim();
}

/**
 * Convert old enumerated format to continuous paragraph.
 * Returns null if already in paragraph format.
 */
function migrateToParapraph(buildScriptContent) {
  if (!buildScriptContent) return null;

  const lines = buildScriptContent.split('\n');
  let hasEnumeration = false;

  for (const line of lines) {
    if (/^\s*\d+\.\s/.test(line) || /^\s*-\s/.test(line)) {
      // Check if this is in the Prompts section
      // Simple heuristic: if the file has numbered lines, it's old format
      hasEnumeration = true;
      break;
    }
  }

  if (!hasEnumeration) return null;

  const paragraph = extractParagraph(buildScriptContent);
  return paragraph || null;
}

// ---------------------------------------------------------------------------
// Format Diff Detail for Prompt Injection
// ---------------------------------------------------------------------------

/**
 * v16.0: Format a diff result into the ADD:/CHANGED:/REMOVED: comment annotation
 * used in BUILD_SCRIPT_FULL.md "Prompts RAW" entries.
 *
 * Returns a pipe-separated string, e.g.:
 *   'ADD: "sentence" | CHANGED: "old" → "new" | REMOVED: "sentence"'
 * Returns empty string if no changes.
 */
function formatComment(diff) {
  const parts = [];
  for (const s of diff.added)    parts.push(`ADD: "${s}"`);
  for (const m of diff.modified) parts.push(`CHANGED: "${m.old}" → "${m.new}"`);
  for (const s of diff.removed)  parts.push(`REMOVED: "${s}"`);
  return parts.join(' | ');
}

/**
 * Format a diff result into a readable string suitable for prompt injection.
 */
function formatDiffDetail(diff) {
  const parts = [];

  for (const sentence of diff.added) {
    parts.push(`ADDED: "${sentence}"`);
  }
  for (const sentence of diff.removed) {
    parts.push(`REMOVED: "${sentence}"`);
  }
  for (const mod of diff.modified) {
    parts.push(`MODIFIED: "${mod.old}" → "${mod.new}"`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  splitSentences,
  diffParagraphs,
  extractParagraph,
  migrateToParapraph,
  formatDiffDetail,
  formatComment,
  similarity,
};
