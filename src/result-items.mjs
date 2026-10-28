import { jsonLanguage } from "@codemirror/lang-json";

// Build ranges from the complete immutable JSON text, rather than the rendered
// viewport or a possibly unfinished background syntax tree. Keep only ranges.
export function jsonResultItems(text) {
  const tree = jsonLanguage.parser.parse(text);
  const array = tree.topNode.firstChild;
  if (!array || array.name !== "Array" || array.nextSibling) return [];
  let invalid = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
    },
  });
  if (invalid) return [];
  const items = [];
  for (let node = array.firstChild; node; node = node.nextSibling) {
    if (["[", "]", ","].includes(node.name)) continue;
    items.push({ index: items.length, from: node.from, to: node.to });
  }
  return items;
}

export function jsonResultItemAt(items, position) {
  if (!Number.isInteger(position) || position < 0) return null;
  let low = 0,
    high = items.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1,
      item = items[mid];
    if (position < item.from) high = mid - 1;
    else if (position >= item.to) low = mid + 1;
    else return item;
  }
  return null;
}
