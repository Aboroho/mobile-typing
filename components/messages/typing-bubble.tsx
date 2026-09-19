'use client';

/**
 * The peer's "typing…" bubble, shown at the bottom of the message list. Subtle
 * by design: three pulsing dots in an incoming-message bubble, announced once
 * to assistive technology through the header status line (aria-live there),
 * so this element is decorative.
 */
export function TypingBubble() {
  return (
    <div className="flex w-full justify-start px-3 animate-fade-in" aria-hidden="true" data-testid="typing-bubble">
      <div className="flex items-center gap-1 rounded-bubble rounded-tl-sm bg-surface-raised px-3 py-2.5 shadow-sm">
        <span className="typing-dot" />
        <span className="typing-dot [animation-delay:150ms]" />
        <span className="typing-dot [animation-delay:300ms]" />
      </div>
    </div>
  );
}
