import { Suspense, useEffect, useRef, useCallback, useMemo, useState, type ReactElement, type FunctionComponent } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewApi,
  type IDockviewHeaderActionsProps,
} from "dockview";
import { Box, IconButton } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "../components";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingPlaceholder } from "../components/LoadingPlaceholder";
import { useLazyImportArrivals } from "../components/lazyImport";
import AddIcon from "@mui/icons-material/Add";
import { useThemeMode } from "../../theme/ThemeModeProvider";
import { PanelSelectorModal } from "./PanelSelectorModal";
import { loadLayout, saveLayout, withKnownPanels } from "./dockingLayoutStorage";
import { isCompactDock, type DefaultLayoutMode } from "./defaultLayout";
import "dockview/dist/styles/dockview.css";

export type PanelDefinition = {
  id: string;
  title: string;
  component: ReactElement;
};

type DockingLayoutProps = {
  panels: PanelDefinition[]; // Panels to initially display
  allPanels?: PanelDefinition[]; // All available panels for cross-instance drag and drop
  onReady?: (api: DockviewApi) => void;
  workspaceId?: string;
  defaultLayoutMode?: DefaultLayoutMode; // How to layout initial panels
  onAddPanelRequest?: (panelId: string) => void;
};

// Store panel components and metadata in Maps
const panelComponentsMap = new Map<string, ReactElement>();
const panelDefinitionsMap = new Map<string, PanelDefinition>();
const dockviewApisMap = new Map<string, DockviewApi>();

/** What every dock panel is rendered in: its id for the tests, an error boundary and the loading state. */
const PanelFrame = ({ panel }: { panel: PanelDefinition }) => {
  // rendered again when the code of a lazily loaded panel has arrived (see lazyImport)
  useLazyImportArrivals();
  return (
    <Box
      data-panel-id={panel.id}
      sx={{ height: "100%", width: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      {/* an exception in one panel must not take the workspace down */}
      <ErrorBoundary scope="panel" name={panel.title} testId={`panel:${panel.id}`}>
        {/* some panels are loaded on first use */}
        <Suspense fallback={<LoadingPlaceholder scope="panel" />}>{panel.component}</Suspense>
      </ErrorBoundary>
    </Box>
  );
};

export const DockingLayout = ({ panels, allPanels, onReady, workspaceId, defaultLayoutMode = 'tabs' }: DockingLayoutProps) => {
  const apiRef = useRef<DockviewApi | null>(null);
  // the element the dock fills: what room a default layout has is measured on it
  const dockRef = useRef<HTMLDivElement | null>(null);
  const { mode } = useThemeMode();
  const isDarkMode = mode === "dark";
  const [modalOpen, setModalOpen] = useState(false);
  const [existingPanelIds, setExistingPanelIds] = useState<string[]>([]);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);

  // Use allPanels if provided, otherwise use panels
  const availablePanels = allPanels || panels;

  // Update the panel components and definitions maps whenever panels change
  useEffect(() => {
    availablePanels.forEach((panel) => {
      panelComponentsMap.set(panel.id, panel.component);
      panelDefinitionsMap.set(panel.id, panel);
    });
  }, [availablePanels]);

  // Create dynamic component types for ALL available panels (not just initial panels)
  const components = useMemo(() => {
    const comps: Record<string, FunctionComponent<IDockviewPanelProps>> = {};

    availablePanels.forEach((panel) => {
      comps[panel.id] = () => <PanelFrame panel={panel} />;
    });

    return comps;
  }, [availablePanels]);

  const onDockviewReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      // Register this API instance for cross-instance drag and drop using dockview's internal ID
      dockviewApisMap.set(event.api.id, event.api);
      console.log('[DockingLayout] Registered API with id:', event.api.id, 'workspace:', workspaceId);

      // Try to load saved layout. It can name panels this build does not have (it was saved by
      // another version of the UI): those are left out, the rest is kept.
      const stored = loadLayout(workspaceId);
      const savedLayout = stored ? withKnownPanels(stored, (allPanels ?? panels).map((panel) => panel.id)) : null;

      // A default layout is made for the room the dock has when it is made (a saved layout is
      // the user's, whatever the window is now; "Reset layout" makes the default again).
      const room = dockRef.current?.getBoundingClientRect();
      const size = { width: room?.width ?? 0, height: room?.height ?? 0 };
      if (savedLayout) {
        try {
          event.api.fromJSON(savedLayout);
        } catch (error) {
          console.warn("Failed to restore docking layout, using default", error);
          createDefaultLayout(event.api, panels, defaultLayoutMode, size);
        }
      } else {
        createDefaultLayout(event.api, panels, defaultLayoutMode, size);
      }

      // Save layout on changes
      const disposables = [
        event.api.onDidLayoutChange(() => {
          saveLayout(event.api.toJSON(), workspaceId);
        }),
        // Enable cross-instance drag and drop
        event.api.onUnhandledDragOverEvent((e) => {
          // Accept the drag event to allow drops from other dockview instances
          e.accept();
        }),
        // Handle the actual drop to transfer panels between instances
        event.api.onWillDrop((e) => {
          const data = e.getData();
          console.log('[onWillDrop]', {
            sourceViewId: data?.viewId,
            targetViewId: event.api.id,
            panelId: data?.panelId,
            isCrossInstance: data && data.viewId !== event.api.id,
          });

          if (data && data.viewId !== event.api.id && data.panelId) {
            // This is a cross-instance drag - prevent default immediately
            e.nativeEvent.preventDefault();
            e.nativeEvent.stopPropagation();

            // Get the panel definition
            const panelDef = panelDefinitionsMap.get(data.panelId);
            if (!panelDef) {
              console.warn(`Panel ${data.panelId} not found in panel definitions`);
              return;
            }

            // Get the source API to remove the panel from
            const sourceApi = dockviewApisMap.get(data.viewId);
            console.log('[onWillDrop] sourceApi found:', !!sourceApi);

            // Remove from source instance BEFORE adding to target
            if (sourceApi) {
              const sourcePanel = sourceApi.getPanel(data.panelId);
              console.log('[onWillDrop] sourcePanel found:', !!sourcePanel);
              if (sourcePanel) {
                sourceApi.removePanel(sourcePanel);
              }
            }

            // Map drop position to direction
            let direction: 'left' | 'right' | 'above' | 'below' | 'within' = 'within';
            switch (e.position) {
              case 'left':
                direction = 'left';
                break;
              case 'right':
                direction = 'right';
                break;
              case 'top':
                direction = 'above';
                break;
              case 'bottom':
                direction = 'below';
                break;
              case 'center':
                direction = 'within';
                break;
            }

            console.log('[onWillDrop] position:', e.position, '-> direction:', direction);

            // Add the panel to this instance
            event.api.addPanel({
              id: data.panelId,
              component: data.panelId,
              title: panelDef.title,
              position: e.group
                ? {
                    referenceGroup: e.group,
                    direction: direction,
                  }
                : {
                    direction: direction,
                  },
            });
          }
        }),
      ];

      // Cleanup
      return () => {
        disposables.forEach((d) => d.dispose());
        dockviewApisMap.delete(event.api.id);
      };
    },
    [panels, allPanels, workspaceId, defaultLayoutMode]
  );

  useEffect(() => {
    if (apiRef.current && onReady) {
      onReady(apiRef.current);
    }
  }, [onReady]);

  // Update existing panel IDs whenever the API changes
  useEffect(() => {
    if (!apiRef.current) return;

    const updatePanelIds = () => {
      if (apiRef.current) {
        setExistingPanelIds(apiRef.current.panels.map((p) => p.id));
      }
    };

    // Initial update
    updatePanelIds();

    // Subscribe to panel changes
    const disposables = [
      apiRef.current.onDidAddPanel(() => updatePanelIds()),
      apiRef.current.onDidRemovePanel(() => updatePanelIds()),
    ];

    return () => {
      disposables.forEach((d) => d.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apiRef.current as a dep re-subscribes on the first render after onDockviewReady assigns it; dropping it changes when the listeners attach
  }, [apiRef.current]);

  const handlePanelSelect = useCallback((panelId: string) => {
    if (!apiRef.current) return;

    const panelDef = panelDefinitionsMap.get(panelId);
    if (!panelDef) {
      console.warn(`Panel ${panelId} not found in panel definitions`);
      return;
    }

    // Add the panel to the target group if specified, otherwise add to the active group
    if (targetGroupId) {
      const targetGroup = apiRef.current.groups.find(g => g.id === targetGroupId);
      if (targetGroup) {
        apiRef.current.addPanel({
          id: panelId,
          component: panelId,
          title: panelDef.title,
          position: {
            referenceGroup: targetGroup,
            direction: 'within',
          },
        });
      } else {
        // Fallback if group not found
        apiRef.current.addPanel({
          id: panelId,
          component: panelId,
          title: panelDef.title,
        });
      }
    } else {
      // Add the panel to the active group or create a new group
      apiRef.current.addPanel({
        id: panelId,
        component: panelId,
        title: panelDef.title,
      });
    }
  }, [targetGroupId]);

  const handleOpenModal = useCallback((groupId?: string) => {
    setTargetGroupId(groupId || null);
    setModalOpen(true);
  }, []);

  // Custom header actions component that shows the "+" button for each group
  const RightHeaderActionsComponent: FunctionComponent<IDockviewHeaderActionsProps> = useCallback(
    ({ api }) => {
      const groupId = api.id;
      return (
        <Tooltip title="Add Panel">
          <IconButton
            onClick={() => handleOpenModal(groupId)}
            size="small"
            sx={{
              height: "100%",
              borderRadius: 0,
              padding: "0 8px",
              marginRight: "4px",
              color: isDarkMode ? "#cccccc" : "#333333",
              "&:hover": {
                backgroundColor: isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.05)",
              },
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      );
    },
    [isDarkMode, handleOpenModal]
  );

  return (
    <>
      <Box
        ref={dockRef}
        sx={{
          height: "100%",
          width: "100%",
          position: "relative",
          "& .dockview-theme": {
            "--dv-background-color": isDarkMode ? "#1e1e1e" : "#ffffff",
            "--dv-activegroup-visiblepanel-tab-background-color": isDarkMode ? "#2d2d30" : "#f3f3f3",
            "--dv-activegroup-hiddenpanel-tab-background-color": isDarkMode ? "#252526" : "#ececec",
            "--dv-inactivegroup-visiblepanel-tab-background-color": isDarkMode ? "#2d2d30" : "#f3f3f3",
            "--dv-inactivegroup-hiddenpanel-tab-background-color": isDarkMode ? "#1e1e1e" : "#e8e8e8",
            "--dv-tabs-and-actions-container-font-size": "13px",
            "--dv-tabs-and-actions-container-height": "35px",
            "--dv-drag-over-background-color": isDarkMode ? "rgba(83, 89, 93, 0.5)" : "rgba(0, 0, 0, 0.1)",
            "--dv-separator-border": isDarkMode ? "#3e3e42" : "#e0e0e0",
            "--dv-paneview-header-border-color": isDarkMode ? "#3e3e42" : "#e0e0e0",
            "--dv-tabs-and-actions-container-font-color": isDarkMode ? "#cccccc" : "#333333",
            "--dv-activegroup-visiblepanel-tab-color": isDarkMode ? "#ffffff" : "#000000",
          },
        }}
      >
        <DockviewReact
          components={components}
          onReady={onDockviewReady}
          className="dockview-theme"
          disableDnd={false}
          rightHeaderActionsComponent={RightHeaderActionsComponent}
        />
      </Box>

      {/* Panel Selection Modal */}
      <PanelSelectorModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handlePanelSelect}
        availablePanels={availablePanels}
        existingPanelIds={existingPanelIds}
      />
    </>
  );
};

// Helper functions

/**
 * The default of a centre dock that has no room for two views side by side (a laptop screen
 * with both side docks open): the first panel above, over the whole width, and the others as
 * tabs of one group below it. `topShare` is the part of the height the first panel gets.
 */
function createStackedLayout(api: DockviewApi, panels: PanelDefinition[], height: number, topShare: number) {
  const firstPanel = api.addPanel({
    id: panels[0].id,
    component: panels[0].id,
    title: panels[0].title,
  });
  if (panels.length > 1) {
    api.addPanel({
      id: panels[1].id,
      component: panels[1].id,
      title: panels[1].title,
      position: { referencePanel: firstPanel, direction: 'below' },
      ...(height > 0 ? { initialHeight: Math.round(height * (1 - topShare)) } : {}),
    });
  }
  for (let i = 2; i < panels.length; i++) {
    api.addPanel({
      id: panels[i].id,
      component: panels[i].id,
      title: panels[i].title,
      position: { referencePanel: panels[1].id, direction: 'within' },
      // the second panel stays the one its group shows
      inactive: true,
    });
  }
  firstPanel.api.setActive();
}

function createDefaultLayout(
  api: DockviewApi,
  panels: PanelDefinition[],
  mode: DefaultLayoutMode = 'tabs',
  size: { width: number; height: number } = { width: 0, height: 0 },
) {
  if (panels.length === 0) return;

  if (isCompactDock(mode, size.width)) {
    // two views one above the other in the mixed-mode workspace; a view above its memory and breakpoints in the others
    createStackedLayout(api, panels, size.height, mode === 'mixed-mode-debugger-layout' ? 0.5 : 0.6);
  } else if (mode === 'mixed-mode-debugger-layout') {
    // Custom debugger layout: SH4 Disassembly (left) | ARM7 Disassembly (right)
    if (panels.length === 0) return;

    // Add first panel (SH4 Disassembly)
    const firstPanel = api.addPanel({
      id: panels[0].id,
      component: panels[0].id,
      title: panels[0].title,
    });

    // Add second panel to the right (ARM7 Disassembly)
    if (panels.length > 1) {
      api.addPanel({
        id: panels[1].id,
        component: panels[1].id,
        title: panels[1].title,
        position: {
          referencePanel: firstPanel,
          direction: 'right',
        },
      });
    }

    // Any additional panels go as tabs in the last group
    for (let i = 2; i < panels.length; i++) {
      api.addPanel({
        id: panels[i].id,
        component: panels[i].id,
        title: panels[i].title,
        position: {
          referencePanel: panels[1].id,
          direction: 'within',
        },
      });
    }

    // Focus the first panel in the left group
    firstPanel.api.setActive();
  } else if (mode === 'sh4-layout') {
    // SH4 layout: first panel on the left, the second and third stacked on the right, and
    // the rest (the register panel of the processor) as tabs behind the third
    if (panels.length === 0) return;

    // Add first panel (SH4 Disassembly)
    const firstPanel = api.addPanel({
      id: panels[0].id,
      component: panels[0].id,
      title: panels[0].title,
    });

    // Add second panel to the right (SH4 Memory)
    if (panels.length > 1) {
      api.addPanel({
        id: panels[1].id,
        component: panels[1].id,
        title: panels[1].title,
        position: {
          referencePanel: firstPanel,
          direction: 'right',
        },
      });
    }

    // Add third panel below second (SH4 Breakpoints)
    if (panels.length > 2) {
      api.addPanel({
        id: panels[2].id,
        component: panels[2].id,
        title: panels[2].title,
        position: {
          referencePanel: panels[1].id,
          direction: 'below',
        },
      });
    }

    // Any additional panels go as tabs in the last group, behind its first panel
    for (let i = 3; i < panels.length; i++) {
      api.addPanel({
        id: panels[i].id,
        component: panels[i].id,
        title: panels[i].title,
        position: {
          referencePanel: panels[2].id,
          direction: 'within',
        },
        // the third panel stays the one its group shows
        inactive: true,
      });
    }

    // Focus the first panel in the left group
    firstPanel.api.setActive();
  } else if (mode === 'vertical-stack') {
    // Create panels stacked vertically with specific heights
    // First panel (50% height)
    const firstPanel = api.addPanel({
      id: panels[0].id,
      component: panels[0].id,
      title: panels[0].title,
    });

    // Second panel below first
    if (panels.length > 1) {
      api.addPanel({
        id: panels[1].id,
        component: panels[1].id,
        title: panels[1].title,
        position: {
          referencePanel: firstPanel,
          direction: 'below',
        },
      });
    }

    // Third panel below second
    if (panels.length > 2) {
      api.addPanel({
        id: panels[2].id,
        component: panels[2].id,
        title: panels[2].title,
        position: {
          referencePanel: panels[1].id,
          direction: 'below',
        },
      });

      // After all panels are added, set the sizes to 50%, 25%, 25%
      setTimeout(() => {
        const totalHeight = api.height;
        const firstGroup = firstPanel.group;
        const secondPanelObj = api.getPanel(panels[1].id);
        const thirdPanelObj = api.getPanel(panels[2].id);

        if (firstGroup && secondPanelObj?.group && thirdPanelObj?.group && totalHeight) {
          // Calculate heights: 50%, 25%, 25%
          const firstHeight = totalHeight * 0.5;
          const secondHeight = totalHeight * 0.25;
          const thirdHeight = totalHeight * 0.25;

          firstGroup.api.setSize({ height: firstHeight });
          secondPanelObj.group.api.setSize({ height: secondHeight });
          thirdPanelObj.group.api.setSize({ height: thirdHeight });
        }
      }, 0);
    }

    // Any additional panels go as tabs in the last group
    for (let i = 3; i < panels.length; i++) {
      api.addPanel({
        id: panels[i].id,
        component: panels[i].id,
        title: panels[i].title,
        position: {
          referencePanel: panels[2].id,
          direction: 'within',
        },
      });
    }

    // Focus the first panel in the top group
    firstPanel.api.setActive();
  } else {
    // Create a single panel group with all panels as tabs
    const firstPanel = api.addPanel({
      id: panels[0].id,
      component: panels[0].id,
      title: panels[0].title,
    });

    // Add remaining panels to the same group
    for (let i = 1; i < panels.length; i++) {
      api.addPanel({
        id: panels[i].id,
        component: panels[i].id,
        title: panels[i].title,
        position: {
          referencePanel: firstPanel,
        },
      });
    }

    // Focus the first panel
    firstPanel.api.setActive();
  }
}
