/**
 * Word Count Plugin for Ohiyo
 *
 * Install URL: http://localhost:5173/plugins/word-count.js
 *
 * Appends word count stats to messages longer than 30 words.
 * Demonstrates user-installable plugin functionality.
 */
export default {
  id: "word-count",
  name: "Word Count",
  description: "Appends word/char count to messages over 30 words. Try it!",
  version: "1.0.0",
  author: "Community",

  transformMessage(msg) {
    const words = msg.content.trim().split(/\s+/).filter(Boolean);
    if (words.length < 30) return msg;
    const chars = msg.content.length;
    return {
      ...msg,
      content: `${msg.content}\n\n📊 ${words.length} words · ${chars} chars`,
    };
  },
};
