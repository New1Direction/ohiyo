/**
 * Rainbow Names Plugin for Ohiyo
 *
 * Install URL: http://localhost:5173/plugins/rainbow-names.js
 *
 * Injects CSS that cycles message author names through rainbow colors.
 * Demonstrates CSS injection via user-installable plugins.
 */
export default {
  id: "rainbow-names",
  name: "Rainbow Names",
  description: "Cycles chat author names through vivid rainbow colors.",
  version: "1.0.0",
  author: "Community",

  css: `
    @keyframes kk-rainbow {
      0%   { color: #ff6b6b; }
      16%  { color: #ffd93d; }
      33%  { color: #6bcb77; }
      50%  { color: #4d96ff; }
      66%  { color: #c77dff; }
      83%  { color: #ff6b9d; }
      100% { color: #ff6b6b; }
    }
    .msg-meta button,
    .msg-meta span[style] {
      animation: kk-rainbow 4s linear infinite !important;
      -webkit-animation: kk-rainbow 4s linear infinite !important;
    }
  `,
};
