import { h, clear, debounce } from './dom.js';

/**
 * Attaches a suggestion popup to a text input.
 *   source(term)   -> Promise<items>
 *   renderItem(it) -> Node
 *   onSelect(it)   -> called when the user picks an item (click / Enter)
 *   footer(term, items) -> optional Node shown below the list (e.g. "will be added")
 * The popup is fixed-positioned on <body> so scrolling tables don't clip it.
 */
export function attachAutocomplete(input, { source, renderItem, onSelect, footer, minLength = 0, delay = 120, openOnFocus = false }) {
  const popup = h('div', { class: 'ac-popup', role: 'listbox', hidden: true });
  document.body.append(popup);
  let items = [];
  let active = -1;
  let seq = 0;
  let open = false;

  const position = () => {
    const r = input.getBoundingClientRect();
    popup.style.left = `${r.left}px`;
    popup.style.top = `${r.bottom + 2}px`;
    popup.style.minWidth = `${Math.max(r.width, 260)}px`;
  };

  const close = () => {
    open = false;
    popup.hidden = true;
    active = -1;
  };

  const highlight = (index) => {
    active = index;
    [...popup.querySelectorAll('.ac-item')].forEach((el, i) => el.classList.toggle('active', i === active));
    const el = popup.querySelectorAll('.ac-item')[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };

  const choose = (index) => {
    const item = items[index];
    if (!item) return;
    close();
    onSelect(item);
  };

  const render = (term) => {
    clear(popup);
    items.forEach((item, i) => {
      popup.append(
        h(
          'div',
          {
            class: 'ac-item',
            role: 'option',
            onmousedown: (e) => {
              e.preventDefault(); // keep focus in the input
              choose(i);
            },
            onmousemove: () => highlight(i),
          },
          renderItem(item)
        )
      );
    });
    const extra = footer ? footer(term, items) : null;
    if (extra) popup.append(h('div', { class: 'ac-footer' }, extra));
    if (!items.length && !extra) return close();
    position();
    popup.hidden = false;
    open = true;
    highlight(items.length ? 0 : -1);
  };

  const refresh = debounce(async () => {
    const term = input.value.trim();
    if (term.length < minLength) return close();
    const mySeq = ++seq;
    const result = await source(term);
    if (mySeq !== seq || document.activeElement !== input) return;
    items = result;
    render(term);
  }, delay);

  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', refresh);
  // An empty field stays quiet on focus (ArrowDown still opens the list) unless
  // the list is a choice the user has to make (openOnFocus).
  input.addEventListener('focus', () => {
    if (openOnFocus || input.value.trim()) refresh();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        refresh();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(items.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(0, active - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  const onScroll = (e) => {
    if (open && !popup.contains(e.target)) close();
  };
  window.addEventListener('scroll', onScroll, true);

  return {
    close,
    destroy() {
      close();
      window.removeEventListener('scroll', onScroll, true);
      popup.remove();
    },
  };
}
