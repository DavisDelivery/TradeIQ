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
