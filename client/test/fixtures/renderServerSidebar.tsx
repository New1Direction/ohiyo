import { renderToStaticMarkup } from "react-dom/server";
import { ServerSidebar } from "../../src/components/ServerSidebar";
export function renderServerSidebar(activeHomeId = "official") {
  return renderToStaticMarkup(<ServerSidebar servers={[]} selectedId={null}
    onSelect={() => {}} onCreateServer={() => {}} onOpenSettings={() => {}} onAddHome={() => {}}
    onSwitchHome={() => {}} activeHomeId={activeHomeId} homes={[
      { id: "official", name: "Ohiyo", url: "https://api.ohiyo.gg", token: null },
      { id: "custom", name: "Friends", url: "https://friends.example", token: null },
    ]} />);
}
