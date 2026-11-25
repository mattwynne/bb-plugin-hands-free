import { decode } from "html-entities";
import { marked, type Token, type Tokens } from "marked";

// Speech engines accept plain text, not Markdown. Parse rather than stripping
// punctuation globally: asterisks, underscores and hashes can be real prose.
export function plainSpeechText(markdown: string): string {
  const inline = (tokens: Token[]): string => tokens.map(token => {
    switch (token.type) {
      case "text": return token.tokens ? inline(token.tokens) : decode(token.text);
      case "escape":
      case "codespan": return decode(token.text);
      case "br": return "\n";
      case "image":
      case "link":
      case "strong":
      case "em":
      case "del": return inline((token as Tokens.Del).tokens);
      case "html": return ""; // Do not send markup or embedded HTML to speech.
      default: return "tokens" in token && token.tokens ? inline(token.tokens) : "";
    }
  }).join("");

  const blocks = (tokens: Token[]): string[] => tokens.flatMap(token => {
    switch (token.type) {
      case "heading":
      case "paragraph":
      case "text": return [inline("tokens" in token && token.tokens ? token.tokens : [token])];
      case "blockquote": return blocks((token as Tokens.Blockquote).tokens);
      case "list": return (token as Tokens.List).items.flatMap(item => blocks(item.tokens));
      case "code": return [decode(token.text)];
      case "table": {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows].map(row => row.map(cell => inline(cell.tokens)).join(", "));
      }
      default: return [];
    }
  });
  return blocks(marked.lexer(markdown)).map(block => block.trim()).filter(Boolean).join("\n");
}

// Wait for completed Markdown when syntax could span the next delta. Plain
// prose can be handed to speech as soon as a sentence boundary is stable.
export function stableSpeechPrefix(text: string): number {
  if (typeof Intl.Segmenter !== "function") return 0;
  if (/[<>&*_~`\[\]#|\\\n]/u.test(text) || /^\s*(?:[-+>]\s|\d+\.\s)/u.test(text)) return 0;
  const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text));
  return sentences.at(-1)?.index ?? 0;
}

export function speechChunks(markdown: string): string[] {
  let text = plainSpeechText(markdown);
  const chunks: string[] = [];
  while (text.length > 700) {
    const space = text.slice(0, 700).search(/\s+\S*$/u);
    const boundary = space > 0 ? space : Array.from(text.slice(0, 701)).slice(0, -1).join("").length;
    chunks.push(text.slice(0, boundary).trim());
    text = text.slice(boundary).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}
