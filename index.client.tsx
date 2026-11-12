import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WatchScreen } from "./client/screen";
import { stateRpc } from "./shared/plan";

const HEARTBEAT_MS = 60_000;

function WatchItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow icon="Radar" active={currentScreen?.screenId === "watch"} onPress={() => openScreen({ screenId: "watch" })} />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "watch", title: "세션 감시", Component: WatchScreen });
  client.addSidebarHeaderItem({ id: "watch", title: "세션 감시", Component: WatchItem });
  // The daemon side gets the Paseo API only through handlers. Calling one on app start and
  // periodically keeps its timers alive after a plugin or daemon restart.
  const ping = () => void client.rpc(stateRpc, {}).catch(() => undefined);
  ping();
  const timer = setInterval(ping, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
