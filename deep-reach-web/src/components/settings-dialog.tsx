"use client";

// Settings dialog — the app's first modal. Talks to /api/settings* (worker
// via glue). Keys are presence-only: the API never returns values, so a key
// field edits by convention — see KeyField:
//   * the input starts EMPTY; its placeholder names the stored state
//     ("Stored in OS keychain" / "From environment variable" / "Required")
//   * PUT includes a key only when the user actually typed into the field:
//     typed value → replace; typed-then-cleared (or "Remove" pressed) → ""
//     → delete; untouched → omitted → kept. No checkbox, no secret echo.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ApiError, api } from "@/lib/api";
import { cx } from "@/lib/cx";
import type {
  SaveSettingsPayload,
  SearchTool,
  Settings,
  SettingsKeyState,
  TestSettingPayload,
  TestSettingResult,
} from "@/lib/types";

export type TabId = "llm" | "search" | "embeddings" | "advanced";

interface FormState {
  llm: { endpoint: string; model: string; thinking: boolean };
  search: { tool: SearchTool; searxng_url: string; throttle_ms: number };
  embeddings: { endpoint: string; model: string };
}

type KeyName = "llm" | "tavily" | "embedding";
const KEY_NAMES: KeyName[] = ["llm", "tavily", "embedding"];

type TestTarget = "llm" | "search" | "embedding";
interface TestState {
  running: boolean;
  result: TestSettingResult | null;
  error: string | null; // ApiError-level failures (e.g. 400 validation)
}

function formFromSettings(s: Settings): FormState {
  return {
    llm: { endpoint: s.llm.endpoint, model: s.llm.model, thinking: s.llm.thinking },
    search: {
      tool: s.search.tool,
      searxng_url: s.search.searxng_url ?? "",
      throttle_ms: s.search.throttle_ms,
    },
    embeddings: { endpoint: s.embeddings.endpoint, model: s.embeddings.model },
  };
}

const emptyTest = (): TestState => ({ running: false, result: null, error: null });

// --- small atoms (shared visual language: hairline, mono labels, segments) --

function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065Z"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** The rail trigger: 24px icon button, dim → text on hover, accent focus ring. */
export function SettingsButton({
  onClick,
  buttonRef,
}: {
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label="Open settings"
      title="Settings"
      className="flex h-6 w-6 items-center justify-center rounded-none text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
    >
      <GearIcon className="h-4 w-4" />
    </button>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function KeyringChip({ keyring }: { keyring: Settings["keyring"] }) {
  return (
    <span
      className={cx(
        "flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em]",
        keyring.available ? "border-ok/40 bg-ok/10 text-ok" : "border-wait/40 bg-wait/10 text-wait",
      )}
    >
      <LockIcon className="h-3 w-3" />
      {keyring.available
        ? `Keychain: ${keyring.backend ?? "os"}`
        : "No keyring backend — keys read from environment"}
    </span>
  );
}

function FieldLabel({ text, htmlFor }: { text: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
      {text}
    </label>
  );
}

function TextField(props: {
  id?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel text={props.label} htmlFor={props.id} />
      <input
        id={props.id}
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cx(
          "rounded-none border border-hairline bg-field px-3 py-2 text-[13px] placeholder:text-dim/60",
          props.mono !== false && "font-mono text-[12px]",
        )}
      />
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">{label}</span>
      <div role="group" aria-label={label} className="flex w-fit border border-hairline">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              "px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              value === o.value ? "bg-raised text-accent" : "text-dim hover:text-text",
            )}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function KeyField(props: {
  id: string;
  label: string;
  state: SettingsKeyState;
  value: string; // what the user has typed; "" = untouched
  onChange: (v: string) => void;
  onRemove: () => void;
  required?: boolean;
}) {
  const { state } = props;
  const [show, setShow] = useState(false);
  const placeholder = !state.present
    ? props.required
      ? "Required — paste to store in keychain"
      : "Optional — paste to store in keychain"
    : state.source === "env"
      ? "From environment variable"
      : "Stored in OS keychain";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <FieldLabel text={props.label} htmlFor={props.id} />
        {state.present && (
          <span
            className={cx(
              "border px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.1em]",
              state.source === "env" ? "border-wait/40 bg-wait/10 text-wait" : "border-ok/40 bg-ok/10 text-ok",
            )}
          >
            {state.source === "env" ? "env" : "keyring"}
          </span>
        )}
      </div>
      <div className="relative flex items-center gap-2">
        <input
          id={props.id}
          type={show ? "text" : "password"}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-none border border-hairline bg-field px-3 py-2 pr-9 font-mono text-[12px] placeholder:text-dim/60"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide key" : "Show key"}
          className="absolute right-2 text-dim hover:text-text"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4" aria-hidden>
            {show ? (
              <>
                <path d="M3 3l18 18" />
                <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-2.2 3M6.2 6.2C3.2 8.1 2 12 2 12s3.5 7 10 7c1.3 0 2.5-.2 3.6-.6" />
              </>
            ) : (
              <>
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
        {state.present && (
          <button
            type="button"
            onClick={props.onRemove}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-dim hover:text-err"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function TestButton({
  running,
  onClick,
  children,
}: {
  running: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={running}
      onClick={onClick}
      className="rounded-none border border-accent px-4 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-accent hover:bg-accent-soft disabled:opacity-50"
    >
      {running ? "Testing…" : children}
    </button>
  );
}

function TestResultLine({ test, renderOk }: { test: TestState | null; renderOk: (r: TestSettingResult) => string }) {
  if (!test) return null;
  if (test.running) return <span className="font-mono text-[11px] text-dim" role="status">testing…</span>;
  if (test.error) return <span className="font-mono text-[11px] text-err" role="status">{test.error}</span>;
  if (test.result?.ok)
    return <span className="font-mono text-[11px] text-ok" role="status">✓ {renderOk(test.result)}</span>;
  if (test.result)
    return (
      <span className="font-mono text-[11px] text-err" role="status">
        {test.result.error ?? "failed"}
      </span>
    );
  return null;
}

// --- the dialog --------------------------------------------------------------

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** the trigger button — refocused when the dialog closes. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function SettingsDialog({ open, onClose, triggerRef }: SettingsDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // Fresh mount = fetch in flight (the page mounts the dialog only while
  // open), so the first render shows the skeleton; writes below all happen
  // after the await, keeping the mount effect side-effect clean.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<TabId>("llm");
  const [keys, setKeys] = useState<Record<KeyName, string>>({ llm: "", tavily: "", embedding: "" });
  const [keyTouched, setKeyTouched] = useState<Record<KeyName, boolean>>({ llm: false, tavily: false, embedding: false });

  const [tests, setTests] = useState<Record<TestTarget, TestState>>({
    llm: emptyTest(),
    search: emptyTest(),
    embedding: emptyTest(),
  });

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);

  // --- data -----------------------------------------------------------------

  // One fetch of the dialog's loaded state.
  const fetchSettings = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSaved(s);
      setForm(formFromSettings(s));
      setKeys({ llm: "", tavily: "", embedding: "" });
      setKeyTouched({ llm: false, tavily: false, embedding: false });
      setTests({ llm: emptyTest(), search: emptyTest(), embedding: emptyTest() });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.body || err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // One extra hop (cf. useTasks): the effect body itself does no setState.
    const run = async () => {
      await fetchSettings();
    };
    void run();
  }, [open, fetchSettings]);

  function retryLoad() {
    setLoading(true);
    setLoadError(null);
    setSaveMsg(null);
    void fetchSettings();
  }

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus: in on open, back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    const t = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>("input, button:not([disabled]), [tabindex]");
      first?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      returnFocusRef.current?.focus?.();
    };
  }, [open, triggerRef]);

  // --- derived state ---------------------------------------------------------

  const dirty = useMemo(() => {
    if (!saved || !form) return false;
    if (form.llm.endpoint !== saved.llm.endpoint) return true;
    if (form.llm.model !== saved.llm.model) return true;
    if (form.llm.thinking !== saved.llm.thinking) return true;
    if (form.search.tool !== saved.search.tool) return true;
    if (form.search.searxng_url !== (saved.search.searxng_url ?? "")) return true;
    if (form.search.throttle_ms !== saved.search.throttle_ms) return true;
    if (form.embeddings.endpoint !== saved.embeddings.endpoint) return true;
    if (form.embeddings.model !== saved.embeddings.model) return true;
    return KEY_NAMES.some((n) => keyTouched[n]);
  }, [saved, form, keyTouched]);

  const embeddingsDirty = useMemo(() => {
    if (!saved || !form) return false;
    return form.embeddings.endpoint !== saved.embeddings.endpoint || form.embeddings.model !== saved.embeddings.model;
  }, [saved, form]);

  function buildPayload(): SaveSettingsPayload {
    const p: SaveSettingsPayload = {};
    if (!saved || !form) return p;
    const llm: SaveSettingsPayload["llm"] = {};
    if (form.llm.endpoint !== saved.llm.endpoint) llm.endpoint = form.llm.endpoint;
    if (form.llm.model !== saved.llm.model) llm.model = form.llm.model;
    if (form.llm.thinking !== saved.llm.thinking) llm.thinking = form.llm.thinking;
    if (Object.keys(llm).length) p.llm = llm;
    const search: NonNullable<SaveSettingsPayload["search"]> = {};
    if (form.search.tool !== saved.search.tool) search.tool = form.search.tool;
    if (form.search.searxng_url !== (saved.search.searxng_url ?? "")) search.searxng_url = form.search.searxng_url;
    if (form.search.throttle_ms !== saved.search.throttle_ms) search.throttle_ms = form.search.throttle_ms;
    if (Object.keys(search).length) p.search = search;
    const emb: SaveSettingsPayload["embeddings"] = {};
    if (form.embeddings.endpoint !== saved.embeddings.endpoint) emb.endpoint = form.embeddings.endpoint;
    if (form.embeddings.model !== saved.embeddings.model) emb.model = form.embeddings.model;
    if (Object.keys(emb).length) p.embeddings = emb;
    const keysPayload: Record<string, string> = {};
    for (const name of KEY_NAMES) if (keyTouched[name]) keysPayload[name] = keys[name];
    if (Object.keys(keysPayload).length) p.keys = keysPayload as SaveSettingsPayload["keys"];
    return p;
  }

  // --- actions -----------------------------------------------------------------

  function setKey(name: KeyName, value: string) {
    setKeys((k) => ({ ...k, [name]: value }));
    setKeyTouched((t) => ({ ...t, [name]: value !== "" || t[name] }));
  }

  function removeKey(name: KeyName) {
    setKeys((k) => ({ ...k, [name]: "" }));
    setKeyTouched((t) => ({ ...t, [name]: true }));
  }

  function runTest(target: TestTarget) {
    if (!form) return;
    const payload: TestSettingPayload = { target };
    if (target === "llm")
      payload.llm = {
        endpoint: form.llm.endpoint || undefined,
        model: form.llm.model || undefined,
        thinking: form.llm.thinking,
        key: keys.llm || undefined,
      };
    if (target === "search")
      payload.search = {
        tool: form.search.tool,
        searxng_url: form.search.searxng_url || undefined,
        throttle_ms: form.search.throttle_ms,
        key: keys.tavily || undefined,
      };
    if (target === "embedding")
      payload.embedding = {
        endpoint: form.embeddings.endpoint || undefined,
        model: form.embeddings.model || undefined,
        key: keys.embedding || undefined,
      };
    setTests((t) => ({ ...t, [target]: { ...t[target], running: true, result: null, error: null } }));
    api
      .testSetting(payload)
      .then((result) =>
        setTests((t) => ({ ...t, [target]: { running: false, result, error: null } })),
      )
      .catch((err) =>
        setTests((t) => ({
          ...t,
          [target]: {
            running: false,
            result: null,
            error: err instanceof ApiError ? err.body || err.message : String(err),
          },
        })),
      );
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await api.saveSettings(buildPayload());
      setSaved(res);
      setForm(formFromSettings(res));
      setKeys({ llm: "", tavily: "", embedding: "" });
      setKeyTouched({ llm: false, tavily: false, embedding: false });
      const restart = res.requires_restart.includes("embeddings")
        ? " · embeddings require a worker restart"
        : "";
      setSaveMsg({ ok: true, text: `Saved — applies to next run${restart}` });
      if (res.errors.length) setSaveMsg({ ok: false, text: res.errors.join("; ") });
    } catch (err) {
      setSaveMsg({ ok: false, text: err instanceof ApiError ? err.body || err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty) {
      if (!closeArmed) {
        setCloseArmed(true);
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setCloseArmed(false), 2500);
        return;
      }
      window.clearTimeout(closeTimer.current);
      setCloseArmed(false);
    }
    onClose();
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  const ready = saved !== null && form !== null && !loading && loadError === null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-field/70 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col border border-hairline bg-raised shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <h2 id={titleId} className="font-display text-[16px] font-bold tracking-[0.14em]">
            SETTINGS
          </h2>
          {saved && <KeyringChip keyring={saved.keyring} />}
          <button
            type="button"
            aria-pressed={closeArmed}
            aria-label={closeArmed ? "Discard changes, press again to confirm" : "Close settings"}
            onClick={requestClose}
            className={cx(
              "ml-auto px-1 font-mono text-[13px]",
              closeArmed ? "font-bold text-err" : "text-dim hover:text-text",
            )}
          >
            {closeArmed ? "!" : "×"}
          </button>
        </div>

        {/* tabs */}
        <div role="tablist" aria-label="Settings sections" className="flex border-b border-hairline px-6">
          {([
            { id: "llm", text: "LLM" },
            { id: "search", text: "Search" },
            { id: "embeddings", text: "Embeddings" },
            { id: "advanced", text: "Advanced" },
          ] as { id: TabId; text: string }[]).map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cx(
                "-mb-px border-b-2 px-4 py-2.5 font-display text-[12px] font-semibold uppercase tracking-[0.12em]",
                tab === t.id ? "border-accent text-text" : "border-transparent text-dim hover:text-text",
              )}
            >
              {t.text}
            </button>
          ))}
        </div>

        {/* body */}
        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="flex-1 overflow-y-auto px-6 py-5"
        >
          {loading && !saved && (
            <div className="flex flex-col gap-4" aria-busy="true">
              {["Endpoint", "Model", "API key", "Test"].map((label) => (
                <div key={label} className="flex flex-col gap-1.5">
                  <div className="h-3 w-24 animate-pulse bg-field" />
                  <div className="h-9 animate-pulse bg-field" />
                  <span className="sr-only">{label} loading</span>
                </div>
              ))}
            </div>
          )}

          {!loading && loadError && (
            <div className="flex flex-col gap-3" role="alert">
              <p className="font-mono text-[12px] text-err">{loadError}</p>
              <button
                type="button"
                onClick={retryLoad}
                className="w-fit rounded-none border border-accent px-3 py-1.5 font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-accent hover:bg-accent-soft"
              >
                Retry
              </button>
            </div>
          )}

          {ready && saved && form && (
            <div className="flex flex-col gap-5">
              {tab === "llm" && (
                <>
                  <TextField
                    id="s-llm-endpoint"
                    label="Endpoint"
                    value={form.llm.endpoint}
                    onChange={(v) => setForm({ ...form, llm: { ...form.llm, endpoint: v } })}
                    placeholder="http://localhost:8080/v1"
                  />
                  <TextField
                    id="s-llm-model"
                    label="Model"
                    value={form.llm.model}
                    onChange={(v) => setForm({ ...form, llm: { ...form.llm, model: v } })}
                    placeholder="omlx/gpt-5.5"
                  />
                  <KeyField
                    id="s-llm-key"
                    label="API key"
                    state={saved.llm.key}
                    value={keys.llm}
                    onChange={(v) => setKey("llm", v)}
                    onRemove={() => removeKey("llm")}
                    required
                  />
                  <Segmented
                    label="Thinking"
                    options={[
                      { value: "off", text: "Off" },
                      { value: "on", text: "On" },
                    ]}
                    value={form.llm.thinking ? "on" : "off"}
                    onChange={(v) => setForm({ ...form, llm: { ...form.llm, thinking: v === "on" } })}
                  />
                  <div className="flex items-center gap-4">
                    <TestButton running={tests.llm.running} onClick={() => runTest("llm")}>
                      Test LLM
                    </TestButton>
                    <TestResultLine
                      test={tests.llm}
                      renderOk={(r) => `${Math.round(r.latency_ms ?? 0)} ms`}
                    />
                  </div>
                </>
              )}

              {tab === "search" && (
                <>
                  <Segmented
                    label="Provider"
                    options={[
                      { value: "searxng" as SearchTool, text: "SearXNG" },
                      { value: "tavily" as SearchTool, text: "Tavily" },
                    ]}
                    value={form.search.tool}
                    onChange={(v) => setForm({ ...form, search: { ...form.search, tool: v } })}
                  />
                  {form.search.tool === "searxng" ? (
                    <>
                      <TextField
                        id="s-searxng-url"
                        label="SearXNG URL"
                        value={form.search.searxng_url}
                        onChange={(v) => setForm({ ...form, search: { ...form.search, searxng_url: v } })}
                        placeholder="http://localhost:8081"
                      />
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-3">
                          <FieldLabel text="Throttle" htmlFor="s-throttle" />
                          <span className="font-mono text-[11px] text-dim">
                            {form.search.throttle_ms} ms
                            {form.search.throttle_ms > 0
                              ? ` · ~${(1000 / form.search.throttle_ms).toFixed(1)} req/s`
                              : " · pacing off"}
                          </span>
                        </div>
                        <input
                          id="s-throttle"
                          type="range"
                          min={0}
                          max={5000}
                          step={250}
                          value={form.search.throttle_ms}
                          onChange={(e) =>
                            setForm({ ...form, search: { ...form.search, throttle_ms: Number(e.target.value) } })
                          }
                          className="w-full accent-[var(--accent)]"
                        />
                        <p className="font-mono text-[10px] text-dim/70">
                          0 disables pacing; raise it if your search engine rate-limits
                        </p>
                      </div>
                    </>
                  ) : (
                    <KeyField
                      id="s-tavily-key"
                      label="Tavily API key"
                      state={saved.search.tavily_key}
                      value={keys.tavily}
                      onChange={(v) => setKey("tavily", v)}
                      onRemove={() => removeKey("tavily")}
                    />
                  )}
                  <div className="flex items-center gap-4">
                    <TestButton running={tests.search.running} onClick={() => runTest("search")}>
                      Test search
                    </TestButton>
                    <TestResultLine
                      test={tests.search}
                      renderOk={(r) =>
                        `${r.result_count ?? 0} results · ${((r.latency_ms ?? 0) / 1000).toFixed(1)} s`
                      }
                    />
                  </div>
                </>
              )}

              {tab === "embeddings" && (
                <>
                  <TextField
                    id="s-emb-endpoint"
                    label="Endpoint"
                    value={form.embeddings.endpoint}
                    onChange={(v) => setForm({ ...form, embeddings: { ...form.embeddings, endpoint: v } })}
                    placeholder="http://localhost:8080/v1"
                  />
                  <TextField
                    id="s-emb-model"
                    label="Model"
                    value={form.embeddings.model}
                    onChange={(v) => setForm({ ...form, embeddings: { ...form.embeddings, model: v } })}
                    placeholder="omlx/nomic-embed-text"
                  />
                  <KeyField
                    id="s-emb-key"
                    label="API key"
                    state={saved.embeddings.key}
                    value={keys.embedding}
                    onChange={(v) => setKey("embedding", v)}
                    onRemove={() => removeKey("embedding")}
                    required
                  />
                  {embeddingsDirty && (
                    <p className="border border-wait/40 bg-wait/10 px-3 py-2 font-mono text-[11px] text-wait">
                      Embedding settings apply after a worker restart
                    </p>
                  )}
                  <div className="flex items-center gap-4">
                    <TestButton running={tests.embedding.running} onClick={() => runTest("embedding")}>
                      Test embeddings
                    </TestButton>
                    <TestResultLine
                      test={tests.embedding}
                      renderOk={(r) => `${r.dim ?? "?"}-dim · ${Math.round(r.latency_ms ?? 0)} ms`}
                    />
                  </div>
                </>
              )}

              {tab === "advanced" && (
                <div className="flex flex-col gap-2" aria-disabled="true">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">Coming later</p>
                  {[
                    "Per-agent models",
                    "Reasoning effort",
                    "Budgets",
                  ].map((row) => (
                    <div
                      key={row}
                      className="border border-hairline px-3 py-2 font-mono text-[12px] text-dim/50"
                    >
                      {row}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-3 border-t border-hairline px-6 py-4">
          <p
            role="status"
            aria-live="polite"
            className={cx(
              "font-mono text-[11px]",
              saveMsg ? (saveMsg.ok ? "text-ok" : "text-err") : "text-dim",
            )}
          >
            {saveMsg?.text ?? (dirty ? "Unsaved changes" : " ")}
          </p>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={requestClose}
              className="rounded-none border border-hairline px-4 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-dim hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className={cx(
                "flex items-center gap-2 rounded-none bg-accent px-5 py-2 font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-field hover:shadow-[0_0_28px_var(--glow)] disabled:opacity-50",
                saving && "hover:shadow-none",
              )}
            >
              {dirty && !saving && <span className="h-1.5 w-1.5 bg-field" aria-hidden />}
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
