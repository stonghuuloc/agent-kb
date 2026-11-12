/** Head and tail of long text: a session's goal is at the start, its outcome at the end. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}
