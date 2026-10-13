// Placeholder: the phone tab bar (see test/phoneNav.test.ts).
export type PhoneTab = "home" | "messages" | "mentions" | "you";
export function PhoneTabBar(_props: { active: PhoneTab; dmUnread: number; mentionCount: number; onSelect: (tab: PhoneTab) => void }) {
  return null;
}
