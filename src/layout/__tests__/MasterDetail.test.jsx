// Phase 4k W2 — MasterDetail branching
//
// Verifies the container's contract:
//   - Mobile width: list renders alone; opening a selection mounts the
//     full-screen modal chrome (data-testid="master-detail-modal").
//   - Desktop width: list + docked side panel render side-by-side
//     (data-testid="master-detail-split" / "master-detail-panel"); the
//     board pane is never hidden behind the detail.
//   - Close button fires onClose in both modes.
//   - Selecting nothing renders only the list in either mode (no chrome).

import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MasterDetail } from '../MasterDetail.jsx';
import { DESKTOP_BREAKPOINT_PX } from '../../hooks/useBreakpoint.js';

function installMatchMedia(matches) {
  const mql = {
    matches,
    media: `(min-width: ${DESKTOP_BREAKPOINT_PX}px)`,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation(() => mql),
  });
}

const List = () => <div data-testid="board-list">board list content</div>;
const Header = () => <div data-testid="detail-header">DETAIL HEADER</div>;
const Body = () => <div data-testid="detail-body">DETAIL BODY</div>;

let originalMatchMedia;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
});

afterEach(() => {
  if (originalMatchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    // @ts-ignore
    delete window.matchMedia;
  }
});

describe('MasterDetail (Phase 4k W2) — mobile', () => {
  beforeEach(() => installMatchMedia(false));

  it('renders only the list when nothing is selected', () => {
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
    expect(screen.queryByTestId('master-detail-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('master-detail-split')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-body')).not.toBeInTheDocument();
  });

  it('opens a full-screen modal when a row is selected', () => {
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('master-detail-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('master-detail-split')).not.toBeInTheDocument();
    expect(screen.getByTestId('detail-header')).toBeInTheDocument();
    expect(screen.getByTestId('detail-body')).toBeInTheDocument();
    // List is still mounted in DOM behind the modal — required for
    // back-and-tap flows.
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
  });

  it('clicking the modal backdrop fires onClose', () => {
    const onClose = vi.fn();
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('master-detail-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the close button fires onClose', () => {
    const onClose = vi.fn();
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={onClose}
        closeLabel="Close target detail"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close target detail' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MasterDetail (Phase 4k W2) — desktop', () => {
  beforeEach(() => installMatchMedia(true));

  it('renders only the list when nothing is selected (no panel chrome)', () => {
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('master-detail-split')).toBeInTheDocument();
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
    expect(screen.queryByTestId('master-detail-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-body')).not.toBeInTheDocument();
  });

  it('renders the list AND docked panel when a row is selected (board never hidden)', () => {
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('master-detail-split')).toBeInTheDocument();
    expect(screen.getByTestId('master-detail-panel')).toBeInTheDocument();
    // Both panes coexist — the whole point of master-detail on desktop.
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
    expect(screen.getByTestId('detail-body')).toBeInTheDocument();
    expect(screen.getByTestId('detail-header')).toBeInTheDocument();
    // No modal chrome is ever mounted on desktop.
    expect(screen.queryByTestId('master-detail-modal')).not.toBeInTheDocument();
  });

  it('clicking the close button in the docked panel fires onClose', () => {
    const onClose = vi.fn();
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={onClose}
        closeLabel="Close target detail"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close target detail' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// EXPAND — the docked panel is too narrow to read the Camillo panel or the
// chart in. These pin the toggle, its persistence, the Escape ordering, and
// the two things that are easy to get wrong: focus survival across the
// toggle, and standing down while a higher overlay is open.
describe('MasterDetail — expand', () => {
  const open = (onClose = () => {}) =>
    render(
      <MasterDetail
        list={<List />}
        detail={<Body />}
        detailHeader={<Header />}
        selected={{ ticker: 'AAPL' }}
        onClose={onClose}
      />,
    );

  beforeEach(() => {
    installMatchMedia(true);
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('starts docked and offers an expand control', () => {
    open();
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Expand to full screen' })).toBeInTheDocument();
  });

  it('expands on click and offers the way back', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
  });

  it('keeps the detail content mounted across the toggle', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    expect(screen.getByTestId('detail-body')).toBeInTheDocument();
    expect(screen.getByTestId('detail-header')).toBeInTheDocument();
  });

  it('KEEPS FOCUS on the toggle across the state change', () => {
    // Declaring the button inside the component body makes it a new component
    // type every render, so React remounts it and focus is lost on the one
    // interaction where it matters. This fails if that regresses.
    open();
    const btn = screen.getByRole('button', { name: 'Expand to full screen' });
    btn.focus();
    fireEvent.click(btn);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Exit full screen' }));
  });

  it('gives the detail the content area and hides the board while expanded', () => {
    open();
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    expect(screen.queryByTestId('board-list')).not.toBeInTheDocument();
  });

  it('does NOT cover the app chrome with a fixed overlay', () => {
    // The app header is sticky z-40. A fixed inset-0 panel either ties with it
    // or covers it, and covering it takes the nav and every filter away from
    // someone mid-read. Expanding must stay inside the content area.
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    const panel = screen.getByTestId('master-detail-panel');
    expect(panel.className).not.toMatch(/\bfixed\b/);
    expect(panel.className).not.toMatch(/\binset-0\b/);
  });

  it('restores the board when collapsed again', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(screen.getByTestId('board-list')).toBeInTheDocument();
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'false');
  });

  it('remembers the preference — it is a workspace choice, not a per-row one', () => {
    const { unmount } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    unmount();
    open();
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'true');
  });

  it('Escape collapses FIRST and only closes once docked', () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));

    // First Escape: collapse, do NOT lose the row being read.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'false');
    expect(onClose).not.toHaveBeenCalled();

    // Second Escape: now it closes.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('STANDS DOWN while a higher overlay is open', () => {
    // The ticker profile modal opens from inside this panel and has no Escape
    // handler of its own. Without this guard, Escape would resize the panel
    // underneath it — a keypress the user cannot see the effect of.
    const onClose = vi.fn();
    open(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));

    const overlay = document.createElement('div');
    overlay.setAttribute('data-overlay', 'modal');
    document.body.appendChild(overlay);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'true');
    expect(onClose).not.toHaveBeenCalled();

    document.body.removeChild(overlay);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'false');
  });

  it('the close button still closes outright, even when expanded', () => {
    const onClose = vi.fn();
    open(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('survives a localStorage that throws, rather than taking the board down', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('private mode'); },
    });
    try {
      open();
      expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'false');
      fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
      expect(screen.getByTestId('master-detail-panel')).toHaveAttribute('data-expanded', 'true');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('mobile gets the control too, and grows the modal', () => {
    installMatchMedia(false);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }));
    expect(screen.getByTestId('master-detail-modal-inner')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('detail-body')).toBeInTheDocument();
  });
});
