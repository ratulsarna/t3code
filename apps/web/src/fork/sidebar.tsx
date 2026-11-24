import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { Columns3Icon } from "lucide-react";
import type { ComponentProps } from "react";

import { SidebarUtilityItem } from "../components/sidebar/SidebarChrome";
import { useSidebar } from "../components/ui/sidebar";
import { BotsSection } from "./bots/BotsSection";

function PipelineShortcut() {
  const navigate = useNavigate();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarUtilityItem
      icon={<Columns3Icon />}
      label={gt("Pipeline")}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/pipeline" });
      }}
    />
  );
}

export const forkSidebar = (bots: ComponentProps<typeof BotsSection>) => ({
  threads: <BotsSection {...bots} />,
  utility: <PipelineShortcut />,
});
