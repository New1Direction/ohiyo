import { useLayoutEffect, useState, type ComponentProps } from "react";
import ResearchTask from "./ResearchTask";
import ProjectReview from "./ProjectReview";

export default function ProjectWorkspace(props: ComponentProps<typeof ResearchTask>) {
  const [planDirty, setPlanDirty] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const { onDirtyChange } = props;
  useLayoutEffect(() => { onDirtyChange(planDirty || draftDirty); return () => onDirtyChange(false); }, [planDirty, draftDirty, onDirtyChange]);
  return <div className="project-workspace">
    <header className="project-heading"><span>{props.task.project}</span><details><summary>Privacy & permissions</summary><p>Your Ohiyo chats stay separate and are never included. Project conversations and materials are stored in your Burrow account, not end-to-end encrypted.</p><p>Writing and reviewing a plan works without AI. Chatting with Kikka shares your request and relevant saved choices with the service you approve. A helper is written guidance, not a new tool. Approval only allows a separate format check; it does not enable the helper.</p><p>Undo restores the previous plan or withdraws permission to check a helper. It cannot remove information already sent to an AI service.</p></details></header>
    <ResearchTask {...props} onDirtyChange={setDraftDirty} projectPlanning>
      <ProjectReview token={props.token} taskId={props.task.id} version={props.task.version} onDirtyChange={setPlanDirty} />
    </ResearchTask>
  </div>;
}
