// useComposerModelState.ts — composer model state: the per-chat manual pick, the live option
// list, and the thinking/web/effort toggles with their capability gates. One shape shared by
// ChatScreen (routing callbacks, ctx meter) and Composer (picker + toggles UI).
import { useEffect, useMemo, useRef, useState } from "react";
import { PROVIDERS, type Message } from "@/entities/model/model/registry";
import type { ModelOption } from "@/entities/model/model/backend";
import type { ModelMenuItem } from "@/entities/model/ui/ModelMenu";
import { anthropicEffortTier, EFFORT_LEVELS, resolveEffort, type EffortLevel } from "@/entities/model/model/apiIds";
import { listAvailableModels, peekAvailableModels, optionAllowsImages, optionAllowsWeb } from "@/features/pick-backend/model/pickBackend";
import { supportsReasoning } from "@/entities/model/lib/pricingSource";
import { clearModelCache } from "@/shared/lib/modelCache";
import { lastOfRole } from "@/shared/lib/lastOfRole";
import { getModelSel, setModelSel as persistModelSel } from "@/pages/chat/model/modelSel";

export type ComposerModelState = ReturnType<typeof useComposerModelState>;

export function useComposerModelState(chatId: string, messages: Message[], loading: boolean) {
  // Persist the manual pick per-chat so it survives a chat/screen switch (like drafts).
  const [modelSel, setModelSelState] = useState<ModelOption | null>(() => getModelSel(chatId));
  const setModelSel = (sel: ModelOption | null) => {
    persistModelSel(chatId, sel);
    setModelSelState(sel);
  };
  const [modelMenuOpen, setModelMenuOpen] = useState(false); // mirrors ModelMenu's open state (drives the refetch below)
  const [thinking, setThinking] = useState(false); // request the reasoning trace
  const [web, setWeb] = useState(true); // server-side web search — on by default
  const [effort, setEffort] = useState<EffortLevel | "auto">("auto"); // Anthropic effort, "auto" = per-model default
  const [effortOpen, setEffortOpen] = useState(false); // effort flyout
  const effortTimer = useRef<number | null>(null);
  const [options, setOptions] = useState<ModelOption[]>(peekAvailableModels);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Refetch the live model list each time the picker opens (reflects newly-connected providers).
  useEffect(() => {
    if (!modelMenuOpen) return;
    let alive = true;
    // Seed from cache for an instant warm list; spin only when nothing's cached.
    const seed = peekAvailableModels();
    if (seed.length) setOptions(seed);
    setModelsLoading(seed.length === 0);
    listAvailableModels()
      .then((o) => alive && setOptions(o))
      .finally(() => alive && setModelsLoading(false));
    return () => {
      alive = false;
    };
  }, [modelMenuOpen]);

  // Default a reopened chat to its last manually-used model: the in-memory pick is lost on restart,
  // but assistant turns record the model on the message. Restore once, only if nothing is picked.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current === chatId) return;
    if (modelSel || getModelSel(chatId)) {
      restoredFor.current = chatId; // already has an explicit pick this session
      return;
    }
    if (loading || options.length === 0) return; // wait for history + the live model list
    const last = lastOfRole(messages, "assistant", (m) => !!m.modelLabel);
    const match = last && options.find((o) => o.label === last.modelLabel && o.provider === last.modelProvider);
    if (match) setModelSel(match);
    restoredFor.current = chatId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, options, messages, loading]);

  // Group the list by connection: a Codex (ChatGPT) account, else the provider's display name.
  // Options arrive already blocked per provider, so a header is shown wherever the group changes.
  const groupName = (o: ModelOption) =>
    o.backend.kind === "chatgpt" ? "Codex" : PROVIDERS[o.provider]?.name ?? o.provider;

  // Map live backend options to the shared ModelMenu item shape (search/paging/scroll live there).
  // Memoized — large lists (OpenRouter: 300+) would otherwise remap on every unrelated render.
  const modelItems = useMemo<ModelMenuItem[]>(
    () =>
      options.map((o) => ({
        key: o.key,
        label: o.label,
        group: groupName(o),
        pid: o.provider,
        modelId: o.provider === "openrouter" ? o.backend.model : undefined,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options]
  );

  // Full refetch (the picker's refresh button): drop caches, spin, replace the list.
  async function refreshModels() {
    clearModelCache();
    setModelsLoading(true);
    try {
      setOptions(await listAvailableModels());
    } finally {
      setModelsLoading(false);
    }
  }

  // Effort selector visibility/levels. Explicit Anthropic pick → its model's tier; Auto →
  // safe low/med/high set when any connected model is Anthropic. resolveEffort is the final gate.
  const effTier = modelSel?.provider === "anthropic" ? anthropicEffortTier(modelSel.backend.model) : null;
  // OpenRouter reasoning models (e.g. Claude) accept low/medium/high effort too — only meaningful with
  // Thinking on. effortLevels/activeEffort fall back to the sonnet set (low/medium/high) when effTier is null.
  const orEffort = modelSel?.provider === "openrouter" && (supportsReasoning(modelSel.backend.model) ?? false) && thinking;
  const showEffort = modelSel ? !!effTier || orEffort : options.some((o) => o.provider === "anthropic");
  // Thinking toggle only for reasoning-capable models (per OpenRouter's catalog). A model unknown to
  // the catalog defaults to shown; the provider backends still gate the actual param. Auto → shown if
  // any connected model can reason.
  const reasoningOk = modelSel
    ? supportsReasoning(modelSel.backend.model) ?? true
    : options.some((o) => (supportsReasoning(o.backend.model) ?? true));
  // Drop a stale "on" state when switching to a model that can't reason.
  useEffect(() => {
    if (!reasoningOk) setThinking(false);
  }, [reasoningOk]);
  const effortLevels = effTier ? EFFORT_LEVELS[effTier] : EFFORT_LEVELS.sonnet;
  const activeEffort = resolveEffort(effTier ?? "sonnet", effort);
  // Thinking/Effort rows animate in/out (on model switch, and Effort when Thinking is toggled). The
  // rows stay mounted and collapse via a CSS grid transition, so each appears/disappears smoothly.
  const hasExtras = reasoningOk || showEffort;
  // Flyout is CSS-anchored to its row (no JS coords — app zoom breaks fixed positioning).
  // Short close delay lets the pointer cross the gap into the flyout.
  const openEffortFly = () => {
    if (effortTimer.current) window.clearTimeout(effortTimer.current);
    effortTimer.current = null;
    setEffortOpen(true);
  };
  const closeEffortFly = () => {
    effortTimer.current = window.setTimeout(() => setEffortOpen(false), 120);
  };

  // Images need a vision-capable model. Auto/unknown allow them; a known text-only pick blocks them.
  const imagesAllowed = optionAllowsImages(modelSel);

  // Web search needs a search-capable backend (Anthropic / Codex / OpenRouter / OpenAI Responses).
  const webAllowed = optionAllowsWeb(modelSel);
  // Drop a stale "on" when switching to a model that can't search.
  useEffect(() => {
    if (!webAllowed) setWeb(false);
  }, [webAllowed]);

  return {
    modelSel,
    setModelSel,
    options,
    modelItems,
    modelsLoading,
    refreshModels,
    setModelMenuOpen,
    thinking,
    setThinking,
    web,
    setWeb,
    effort,
    setEffort,
    effortOpen,
    setEffortOpen,
    openEffortFly,
    closeEffortFly,
    effortLevels,
    activeEffort,
    hasExtras,
    reasoningOk,
    showEffort,
    imagesAllowed,
    webAllowed,
  };
}
