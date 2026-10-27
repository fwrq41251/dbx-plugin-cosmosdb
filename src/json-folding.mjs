import { jsonLanguage } from "@codemirror/lang-json";

// Preserve the root and its field names; fold only the first nested value level.
// Parse the whole text so results don't depend on CodeMirror's current viewport
// or the background parser having reached a long document's final line.
export function nestedJSONFolds(text) {
  const ranges = [];
  let depth = 0,
    invalid = false;
  jsonLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
      if (node.name === "Object" || node.name === "Array") {
        depth++;
        const from = node.from + 1,
          to = node.to - 1;
        if (depth === 2 && text.slice(from, to).trim())
          ranges.push({ from, to });
      }
    },
    leave(node) {
      if (node.name === "Object" || node.name === "Array") depth--;
    },
  });
  return invalid ? [] : ranges;
}
