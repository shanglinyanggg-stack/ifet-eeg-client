import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface ThemedSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface ThemedSelectProps {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

const MENU_GAP = 6;
const MENU_VIEWPORT_PADDING = 8;
const MENU_MAX_HEIGHT = 260;
const MENU_MIN_HEIGHT = 36;
const MENU_OPTION_HEIGHT = 34;
const MENU_VERTICAL_PADDING = 12;

export function ThemedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled = false
}: ThemedSelectProps) {
  const selectId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => resolveSelectedIndex(options, value));
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [portalTarget, setPortalTarget] = useState<Element | DocumentFragment | null>(null);

  const selectedIndex = resolveSelectedIndex(options, value);
  const selectedOption = options[selectedIndex] ?? options[0];
  const activeOptionId = `${selectId}-option-${activeIndex}`;

  // 在菜单打开的同一渲染周期内确定 portal 目标，避免首次打开时 buttonRef 还未挂载到 DOM 树
  useLayoutEffect(() => {
    if (!open) return;
    setPortalTarget(resolvePortalTarget(buttonRef.current));
  }, [open]);

  useEffect(() => {
    if (open) return;
    setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const estimatedHeight = Math.min(
        MENU_MAX_HEIGHT,
        options.length * MENU_OPTION_HEIGHT + MENU_VERTICAL_PADDING
      );
      const availableBelow = Math.max(
        0,
        window.innerHeight - rect.bottom - MENU_GAP - MENU_VIEWPORT_PADDING
      );
      const availableAbove = Math.max(
        0,
        rect.top - MENU_GAP - MENU_VIEWPORT_PADDING
      );
      const placement = availableBelow < estimatedHeight && availableAbove > availableBelow
        ? 'above'
        : 'below';
      const availableHeight = placement === 'above' ? availableAbove : availableBelow;

      setMenuPosition({
        left: rect.left,
        top: placement === 'below' ? rect.bottom + MENU_GAP : undefined,
        bottom: placement === 'above' ? window.innerHeight - rect.top + MENU_GAP : undefined,
        width: rect.width,
        maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, availableHeight)),
        placement
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const activeItem = document.getElementById(activeOptionId);
    activeItem?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId, open]);

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const commitValue = (option: ThemedSelectOption) => {
    if (option.disabled) return;
    if (option.value !== value) {
      onChange(option.value);
    }
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const option = options[activeIndex];
      if (option) commitValue(option);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((index) => moveActiveIndex(options, index, event.key === 'ArrowDown' ? 1 : -1));
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(findEnabledIndex(options, event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1));
    }
  };

  const menu =
    open && menuPosition && portalTarget
      ? createPortal(
          <div
            ref={menuRef}
            id={`${selectId}-menu`}
            className="themed-select-menu"
            role="listbox"
            aria-label={ariaLabel}
            data-placement={menuPosition.placement}
            style={
              {
                '--select-left': `${menuPosition.left}px`,
                '--select-top': menuPosition.top === undefined ? undefined : `${menuPosition.top}px`,
                '--select-bottom': menuPosition.bottom === undefined ? undefined : `${menuPosition.bottom}px`,
                '--select-width': `${menuPosition.width}px`,
                '--select-max-height': `${menuPosition.maxHeight}px`
              } as CSSProperties
            }
          >
            {options.map((option, index) => (
              <div
                id={`${selectId}-option-${index}`}
                key={option.value}
                className="themed-select-option"
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={index === activeIndex || undefined}
                data-selected={option.value === value || undefined}
                data-disabled={option.disabled || undefined}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => commitValue(option)}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={15} aria-hidden="true" />}
              </div>
            ))}
          </div>,
          portalTarget
        )
      : null;

  return (
    <div className={className ? `themed-select ${className}` : 'themed-select'}>
      <button
        ref={buttonRef}
        className="themed-select-trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${selectId}-menu` : undefined}
        aria-activedescendant={open ? activeOptionId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span>{selectedOption?.label ?? ''}</span>
        <ChevronDown className="themed-select-chevron" size={16} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}

function resolveSelectedIndex(options: ThemedSelectOption[], value: string): number {
  const index = options.findIndex((option) => option.value === value);
  return index >= 0 ? index : 0;
}

function moveActiveIndex(options: ThemedSelectOption[], currentIndex: number, direction: 1 | -1): number {
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= options.length) return currentIndex;
  return findEnabledIndex(options, nextIndex, direction);
}

function findEnabledIndex(options: ThemedSelectOption[], startIndex: number, direction: 1 | -1): number {
  for (let index = startIndex; index >= 0 && index < options.length; index += direction) {
    if (!options[index]?.disabled) return index;
  }
  return resolveSelectedIndex(options, options[0]?.value ?? '');
}

function resolvePortalTarget(element: HTMLElement | null): Element | DocumentFragment | null {
  if (typeof document === 'undefined') return null;
  return element?.closest('.app-shell') ?? document.body;
}
