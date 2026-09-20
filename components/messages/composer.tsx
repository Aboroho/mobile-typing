'use client';

import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Mic, Send, Smile, X } from 'lucide-react';
import { MESSAGE_MAX_LENGTH } from '@mt/types';
import { cn } from '@/components/ui/cn';
import { useChatStore } from '@/stores/chat-store';
import { useMediaUpload } from '@/hooks/use-media-upload';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { VoiceLevelMeter } from '@/components/voice-messages/voice-message';

const EMOJI = ['😀', '😂', '🙂', '😊', '😍', '🤔', '😢', '😮', '👍', '🙏', '❤️', '🔥', '🎉', '✅'];

export function Composer({
  conversationId,
  replyToId,
  onClearReply,
}: {
  conversationId: string;
  replyToId: string | null;
  onClearReply: () => void;
}) {
  const [text, setText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const sendText = useChatStore((state) => state.sendText);
  const sendMedia = useChatStore((state) => state.sendMedia);
  const setTyping = useChatStore((state) => state.setTyping);
  const upload = useMediaUpload();
  const recorder = useVoiceRecorder();

  // Leaving the conversation (or unmounting) always clears the indicator, so
  // the peer never sees a stuck "typing…".
  useEffect(() => {
    return () => setTyping(conversationId, false);
  }, [conversationId, setTyping]);

  /**
   * Typing signal. The store debounces it: the first keystroke goes out
   * immediately, later keystrokes only push the automatic stop further out,
   * and the composer never has to schedule its own timer.
   */
  const notifyTyping = () => setTyping(conversationId, true);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    onClearReply();
    // Sending is the definitive "not typing any more".
    setTyping(conversationId, false);
    await sendText(conversationId, value, replyToId ?? undefined);
  };

  const attachImage = async (file: File) => {
    const mediaId = await upload.uploadImage(file);
    if (!mediaId) return;
    await sendMedia({ conversationId, mediaId, type: 'image', caption: text.trim() || undefined, viewOnce });
    setText('');
    setViewOnce(false);
    upload.reset();
  };

  return (
    <div className="border-t border-line bg-surface px-2 py-2 safe-bottom">
      {upload.progress.phase !== 'idle' && upload.progress.phase !== 'done' ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-ink-muted">
          <span>{upload.progress.phase === 'compressing' ? 'Preparing image…' : 'Uploading…'}</span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
            <span
              className="block h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${Math.round(upload.progress.ratio * 100)}%` }}
            />
          </span>
          <button type="button" onClick={upload.cancel} aria-label="Cancel upload">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {recorder.phase === 'recording' ? (
        <div className="mb-2 flex items-center gap-3 rounded-lg bg-surface-raised px-3 py-2">
          <VoiceLevelMeter level={recorder.level} durationMs={recorder.durationMs} />
          <button type="button" onClick={() => void recorder.stop()} className="rounded-lg bg-brand px-3 py-1 text-xs text-white">
            Stop
          </button>
          <button type="button" onClick={recorder.cancel} className="text-xs text-ink-muted">
            Cancel
          </button>
        </div>
      ) : null}

      {recorder.phase === 'review' && recorder.previewUrl ? (
        <div className="mb-2 flex items-center gap-3 rounded-lg bg-surface-raised px-3 py-2">
          <audio src={recorder.previewUrl} controls className="h-8 flex-1" />
          <button
            type="button"
            onClick={async () => {
              const mediaId = await recorder.send();
              if (mediaId) await sendMedia({ conversationId, mediaId, type: 'voice' });
            }}
            className="rounded-lg bg-brand px-3 py-1 text-xs text-white"
          >
            Send
          </button>
          <button type="button" onClick={recorder.discard} className="text-xs text-ink-muted">
            Discard
          </button>
        </div>
      ) : null}

      {emojiOpen ? (
        <div className="mb-2 grid grid-cols-7 gap-1 rounded-lg bg-surface-raised p-2">
          {EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => setText((current) => `${current}${emoji}`)}
              className="rounded p-1 text-xl hover:bg-surface-sunken"
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-1">
        <button
          type="button"
          aria-label="Add emoji"
          onClick={() => setEmojiOpen((open) => !open)}
          className="rounded-full p-2 text-ink-muted hover:bg-surface-raised"
        >
          <Smile className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="Attach photo"
          onClick={() => fileRef.current?.click()}
          className={cn('rounded-full p-2 text-ink-muted hover:bg-surface-raised', viewOnce && 'text-brand')}
        >
          <ImageIcon className="h-5 w-5" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void attachImage(file);
          }}
        />
        <textarea
          value={text}
          onChange={(event) => {
            const next = event.target.value.slice(0, MESSAGE_MAX_LENGTH);
            setText(next);
            if (next.trim()) notifyTyping();
            else setTyping(conversationId, false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder="Message"
          aria-label="Message"
          className="max-h-28 flex-1 resize-none rounded-2xl border border-line bg-surface-raised px-3 py-2 text-sm outline-none focus:border-brand"
        />
        {text.trim() ? (
          <button
            type="button"
            onClick={() => void submit()}
            aria-label="Send message"
            className="rounded-full bg-brand p-2 text-white"
          >
            <Send className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void recorder.start()}
            aria-label="Record voice message"
            className="rounded-full bg-brand p-2 text-white"
          >
            <Mic className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between px-2 text-[10px] text-ink-faint">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={viewOnce}
            onChange={(event) => setViewOnce(event.target.checked)}
            className="accent-brand"
          />
          Next photo is view once
        </label>
        <span>{text.length}/{MESSAGE_MAX_LENGTH}</span>
      </div>
    </div>
  );
}
