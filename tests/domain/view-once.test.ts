import { describe, expect, it } from 'vitest';
import { ViewOnceState } from '@mt/types';
import {
  canFetchViewOnceBytes,
  canRequestViewOnce,
  isTerminalViewOnceState,
  resolveViewOnceRequest,
  transitionViewOnce,
} from '@/lib/domain/view-once';

const media = (viewOnceState: ViewOnceState, ownerId = 'owner') => ({
  viewOnce: true,
  viewOnceState,
  ownerId,
  deleted: false,
});

describe('transitionViewOnce', () => {
  it('follows the documented lifecycle', () => {
    expect(transitionViewOnce(ViewOnceState.Sent, 'deliver')).toBe(ViewOnceState.Delivered);
    expect(transitionViewOnce(ViewOnceState.Delivered, 'request')).toBe(ViewOnceState.Viewable);
    expect(transitionViewOnce(ViewOnceState.Viewable, 'request')).toBe(ViewOnceState.Viewing);
    expect(transitionViewOnce(ViewOnceState.Viewing, 'opened')).toBe(ViewOnceState.Viewed);
  });

  it('has no way back once viewed', () => {
    expect(transitionViewOnce(ViewOnceState.Viewed, 'request')).toBeNull();
    expect(transitionViewOnce(ViewOnceState.Viewed, 'deliver')).toBeNull();
    expect(isTerminalViewOnceState(ViewOnceState.Viewed)).toBe(true);
    expect(isTerminalViewOnceState(ViewOnceState.Expired)).toBe(true);
    expect(isTerminalViewOnceState(ViewOnceState.Deleted)).toBe(true);
    expect(isTerminalViewOnceState(ViewOnceState.Viewable)).toBe(false);
  });

  it('only serves bytes while the media is in the transient viewing state', () => {
    expect(canFetchViewOnceBytes(ViewOnceState.Viewing)).toBe(true);
    expect(canFetchViewOnceBytes(ViewOnceState.Viewable)).toBe(false);
    expect(canFetchViewOnceBytes(ViewOnceState.Viewed)).toBe(false);
  });
});

describe('resolveViewOnceRequest — the single-view rule', () => {
  it('allows the first open by the recipient', () => {
    const decision = resolveViewOnceRequest({ media: media(ViewOnceState.Delivered), viewerId: 'recipient' });
    expect(decision.allowed).toBe(true);
    expect(decision.nextState).toBe(ViewOnceState.Viewable);
  });

  it('refuses a second open once viewed', () => {
    const decision = resolveViewOnceRequest({ media: media(ViewOnceState.Viewed), viewerId: 'recipient' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/already been viewed/);
  });

  it('refuses the sender, who never consumes their own view', () => {
    const decision = resolveViewOnceRequest({ media: media(ViewOnceState.Delivered), viewerId: 'owner' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/sender/);
  });

  it('refuses a third party even when they are a participant of the conversation', () => {
    const decision = resolveViewOnceRequest({
      media: media(ViewOnceState.Delivered),
      viewerId: 'intruder',
      allowedViewerId: 'recipient',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not the recipient/);
  });

  it('accepts the recipient the caller resolved from the conversation', () => {
    const decision = resolveViewOnceRequest({
      media: media(ViewOnceState.Delivered),
      viewerId: 'recipient',
      allowedViewerId: 'recipient',
    });
    expect(decision.allowed).toBe(true);
  });

  it('refuses ordinary (non view-once) media', () => {
    const decision = resolveViewOnceRequest({
      media: { ...media(ViewOnceState.Delivered), viewOnce: false, viewOnceState: null },
      viewerId: 'recipient',
    });
    expect(decision.allowed).toBe(false);
  });

  it('lets an administrator inspect deleted media and bypass the recipient rule', () => {
    const deleted = resolveViewOnceRequest({
      media: { ...media(ViewOnceState.Delivered), deleted: true },
      viewerId: 'admin',
      isAdmin: true,
    });
    expect(deleted.allowed).toBe(true);
    const asThirdParty = resolveViewOnceRequest({
      media: media(ViewOnceState.Delivered),
      viewerId: 'admin',
      allowedViewerId: 'recipient',
      isAdmin: true,
    });
    expect(asThirdParty.allowed).toBe(true);
    expect(
      resolveViewOnceRequest({ media: { ...media(ViewOnceState.Delivered), deleted: true }, viewerId: 'recipient' })
        .allowed,
    ).toBe(false);
  });

  it('treats the viewing state as consumed, so a crashed client cannot re-open', () => {
    expect(canRequestViewOnce(ViewOnceState.Viewing)).toBe(false);
    expect(canRequestViewOnce(ViewOnceState.Delivered)).toBe(true);
    expect(canRequestViewOnce(ViewOnceState.Viewable)).toBe(true);
  });
});
