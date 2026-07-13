import { splitProps, type JSX, type ParentProps, Show } from 'solid-js';

/* Shared UI primitives. All views build from these so the panel stays visually
   coherent and the no-layout-shift rules live in one place. */

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent hover:bg-accent-hover text-white border-transparent disabled:bg-surface-3 disabled:text-text-faint',
  ghost:
    'bg-surface-2 hover:bg-surface-3 text-text border-border disabled:text-text-faint disabled:hover:bg-surface-2',
  danger: 'bg-danger-soft hover:bg-danger/30 text-danger border-transparent',
};

export function Button(
  props: ParentProps<
    JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: ButtonVariant;
      loading?: boolean;
    }
  >,
) {
  const [local, rest] = splitProps(props, ['variant', 'loading', 'children', 'class', 'disabled']);
  return (
    <button
      {...rest}
      disabled={local.disabled || local.loading}
      class={`relative inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${buttonVariants[local.variant ?? 'ghost']} ${local.class ?? ''}`}
    >
      {/* Spinner overlays instead of replacing the label — button width never shifts. */}
      <span class={`inline-flex items-center gap-1.5 ${local.loading ? 'invisible' : ''}`}>
        {local.children}
      </span>
      <Show when={local.loading}>
        <span class="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      </Show>
    </button>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      class="border-text-dim inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-t-transparent"
    />
  );
}

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return (
    <input
      {...rest}
      class={`bg-surface-2 border-border focus:border-accent placeholder:text-text-faint h-7 w-full rounded-md border px-2 text-[12px] outline-none transition-colors ${local.class ?? ''}`}
    />
  );
}

export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [local, rest] = splitProps(props, ['class']);
  return (
    <textarea
      {...rest}
      class={`bg-surface-2 border-border focus:border-accent placeholder:text-text-faint w-full resize-y rounded-md border px-2 py-1.5 text-[12px] leading-relaxed outline-none transition-colors ${local.class ?? ''}`}
    />
  );
}

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <select
      {...rest}
      class={`bg-surface-2 border-border focus:border-accent h-7 w-full cursor-pointer rounded-md border px-1.5 text-[12px] outline-none ${local.class ?? ''}`}
    >
      {local.children}
    </select>
  );
}

export function Field(props: ParentProps<{ label: string; hint?: string }>) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-text-dim text-[11px] font-medium">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="text-text-faint text-[10.5px] leading-snug">{props.hint}</span>
      </Show>
    </label>
  );
}

export function Section(props: ParentProps<{ title: string }>) {
  return (
    <section class="flex flex-col gap-2.5">
      <h2 class="text-text-dim text-[11px] font-semibold tracking-wide uppercase">{props.title}</h2>
      {props.children}
    </section>
  );
}

export function Badge(props: ParentProps<{ color?: string; class?: string }>) {
  return (
    <span
      class={`bg-surface-3 text-text-dim inline-flex h-[18px] items-center gap-1 rounded-full px-2 text-[10.5px] font-medium whitespace-nowrap ${props.class ?? ''}`}
      style={props.color ? { color: props.color } : undefined}
    >
      {props.children}
    </span>
  );
}

/** Workflow-state dot matching Linear's state colors. Fixed size — never shifts rows. */
export function StateDot(props: { color: string }) {
  return (
    <span
      aria-hidden
      class="inline-block size-2 shrink-0 rounded-full"
      style={{ background: props.color }}
    />
  );
}

export function EmptyState(props: ParentProps<{ title: string }>) {
  return (
    <div class="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <p class="text-text-dim text-[12px] font-medium">{props.title}</p>
      <div class="text-text-faint text-[11.5px] leading-relaxed">{props.children}</div>
    </div>
  );
}

export function ErrorNote(props: { message: string }) {
  return (
    <p class="bg-danger-soft text-danger rounded-md px-2.5 py-1.5 text-[11.5px] leading-snug break-words">
      {props.message}
    </p>
  );
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export function timeAgo(iso: string | number): string {
  const then = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
