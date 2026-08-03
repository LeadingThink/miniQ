import { AppShell } from "./components/AppShell";
import { useMiniqApp } from "./hooks/useMiniqApp";

export type { PendingApproval } from "./hooks/useSessionFeed";

export default function App() {
  const app = useMiniqApp();
  return <AppShell app={app} />;
}
