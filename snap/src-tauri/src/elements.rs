//! What is under a point inside a window: the button, the paragraph, the panel holding them, out to
//! the window itself — so the overlay can snap to a part of a window as it snaps to windows.
//!
//! Windows only, through MSAA (`IAccessible`), which every kind of app answers: Win32 and WPF ones
//! directly, browsers (Chrome, Edge, Firefox) and Electron apps for every element of the page, UWP and
//! WinUI ones through the system's bridge from UI Automation. MSAA rather than UI Automation for one
//! thing: it hit-tests inside a given window (`accHitTest`). UI Automation only finds the element at a
//! point on screen, and while picking, the point on screen is our own overlay.
//!
//! Queries go to the window's app and back, so they run on a thread of their own, never the UI's.

use crate::geometry::Rect;

/// One element under the point, in screen pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Element {
    pub rect: Rect,
    pub role: String,
    pub name: String,
}

/// The elements under screen point (`x`, `y`) of the top-level window `hwnd`, innermost first and
/// ending at the outermost the window reports. Empty when the window answers nothing.
#[cfg(windows)]
pub fn chain_at(hwnd: isize, x: i32, y: i32) -> Vec<Element> {
    imp::chain_at(hwnd, x, y)
}

#[cfg(not(windows))]
pub fn chain_at(_hwnd: isize, _x: i32, _y: i32) -> Vec<Element> {
    Vec::new()
}

/// Get a browser window (Chrome, Edge and the other Chromium browsers) to build the tree of its page.
/// Chromium answers MSAA with the bare window until a UI Automation client looks into the page — a
/// search for its document does it — and takes about a second after that.
///
/// Browsers only, told by their executable. Electron apps are Chromium too, but some take the same
/// signal for a screen reader starting: VS Code switches its editor to screen-reader mode. Other apps
/// answer as they are, and a search through a big app's tree would cost it for nothing.
#[cfg(windows)]
pub fn wake(hwnd: isize) {
    imp::wake(hwnd)
}

#[cfg(not(windows))]
pub fn wake(_hwnd: isize) {}

/// Keep what is worth snapping to: inside the window, not a sliver, not a text run (the words inside
/// a button or a paragraph — the button or paragraph is what anyone means), and each one around the
/// one before and visibly bigger than it, so every step outwards takes in something more. Pages nest
/// boxes a pixel apart by the dozen; stepping through those would look like nothing happening.
pub fn tidy(chain: Vec<Element>, window: &Rect) -> Vec<Element> {
    let mut out: Vec<Element> = Vec::new();
    for e in chain {
        if e.role == "text" {
            continue;
        }
        let Some(r) = e.rect.intersect(window) else { continue };
        if r.width < MIN_SIDE || r.height < MIN_SIDE {
            continue;
        }
        if let Some(last) = out.last() {
            if !contains(&r, &last.rect) || !grows(&r, &last.rect) {
                continue;
            }
        }
        out.push(Element { rect: r, ..e });
    }
    out
}

const MIN_SIDE: u32 = 6;
/// How far past the last box, on some side, the next one must reach to be a step of its own.
const MIN_GROWTH: i64 = 8;

fn grows(outer: &Rect, inner: &Rect) -> bool {
    (inner.x as i64 - outer.x as i64) >= MIN_GROWTH
        || (inner.y as i64 - outer.y as i64) >= MIN_GROWTH
        || outer.right() - inner.right() >= MIN_GROWTH
        || outer.bottom() - inner.bottom() >= MIN_GROWTH
}

fn contains(outer: &Rect, inner: &Rect) -> bool {
    outer.x <= inner.x && outer.y <= inner.y && outer.right() >= inner.right() && outer.bottom() >= inner.bottom()
}

#[cfg(windows)]
mod imp {
    use super::Element;
    use crate::geometry::Rect;
    use windows::core::{Interface, BSTR};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, POINT};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IDispatch, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::Variant::{VariantClear, VARIANT, VT_DISPATCH, VT_I4};
    use windows::Win32::UI::Accessibility::{
        AccessibleObjectFromWindow, CUIAutomation, IAccessible, IUIAutomation, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_DocumentControlTypeId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, GetClassNameW, GetWindowThreadProcessId, IsHungAppWindow, CWP_SKIPDISABLED,
        CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, OBJID_CLIENT,
    };

    /// Deep enough for any real page; a cycle in a misbehaving app's tree stops here.
    const MAX_DEPTH: usize = 128;
    const CHILDID_SELF: i32 = 0;
    const ROLE_SYSTEM_STATICTEXT: i32 = 0x29;
    /// Chromium browsers, by executable name.
    const BROWSERS: &[&str] = &["chrome", "msedge", "brave", "vivaldi", "opera", "chromium", "thorium", "arc"];

    pub fn chain_at(hwnd: isize, x: i32, y: i32) -> Vec<Element> {
        unsafe {
            // Once per thread; a second call on the same thread just says so.
            // A hung app never answers: asking would hold this thread for good.
            if IsHungAppWindow(HWND(hwnd as _)).as_bool() {
                return Vec::new();
            }
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let target = deepest_child(HWND(hwnd as _), x, y);
            let mut root: *mut core::ffi::c_void = std::ptr::null_mut();
            if AccessibleObjectFromWindow(target, OBJID_CLIENT.0 as u32, &IAccessible::IID, &mut root).is_err()
                || root.is_null()
            {
                return Vec::new();
            }
            let root = IAccessible::from_raw(root);
            let (leaf, child) = hit_test(root, x, y);
            let mut chain = Vec::new();
            if child != CHILDID_SELF {
                // A simple child (a list item, a toolbar button) lives in its parent object.
                if let Some(e) = describe(&leaf, child) {
                    chain.push(e);
                }
            }
            let mut node = Some(leaf);
            for _ in 0..MAX_DEPTH {
                let Some(acc) = node else { break };
                if let Some(e) = describe(&acc, CHILDID_SELF) {
                    chain.push(e);
                }
                node = acc.accParent().ok().and_then(|p: IDispatch| p.cast::<IAccessible>().ok());
            }
            chain
        }
    }

    pub fn wake(hwnd: isize) {
        unsafe {
            let hwnd = HWND(hwnd as _);
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class) as usize;
            if !String::from_utf16_lossy(&class[..n]).starts_with("Chrome_WidgetWin")
                || !is_browser(hwnd)
                || IsHungAppWindow(hwnd).as_bool()
            {
                return;
            }
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return };
            let Ok(root) = uia.ElementFromHandle(hwnd) else { return };
            let document = VARIANT::from(UIA_DocumentControlTypeId.0);
            if let Ok(cond) = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &document) {
                let _ = root.FindFirst(TreeScope_Descendants, &cond);
            }
        }
    }

    fn is_browser(hwnd: HWND) -> bool {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            if named.is_err() {
                return false;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_lowercase());
            stem.is_some_and(|s| BROWSERS.contains(&s.as_str()))
        }
    }

    /// The child window under the point: a browser draws its page in one, an app's panes may be others.
    unsafe fn deepest_child(top: HWND, x: i32, y: i32) -> HWND {
        let mut h = top;
        for _ in 0..32 {
            let mut p = POINT { x, y };
            if !unsafe { ScreenToClient(h, &mut p) }.as_bool() {
                break;
            }
            let child = unsafe { ChildWindowFromPointEx(h, p, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT) };
            if child.is_invalid() || child == h {
                break;
            }
            h = child;
        }
        h
    }

    /// Down from `acc` to the innermost object at the point, and the simple child of it there if any.
    unsafe fn hit_test(mut acc: IAccessible, x: i32, y: i32) -> (IAccessible, i32) {
        for _ in 0..MAX_DEPTH {
            let Ok(mut v) = (unsafe { acc.accHitTest(x, y) }) else { break };
            let inner = unsafe { &v.Anonymous.Anonymous };
            let next = if inner.vt == VT_DISPATCH {
                let disp = unsafe { &*inner.Anonymous.pdispVal };
                disp.as_ref().and_then(|d| d.cast::<IAccessible>().ok())
            } else if inner.vt == VT_I4 && unsafe { inner.Anonymous.lVal } != CHILDID_SELF {
                let child = unsafe { inner.Anonymous.lVal };
                unsafe { clear(&mut v) };
                return (acc, child);
            } else {
                // VT_EMPTY (outside) or CHILDID_SELF: this object is the innermost.
                None
            };
            unsafe { clear(&mut v) };
            match next {
                Some(n) if n != acc => acc = n,
                _ => break,
            }
        }
        (acc, CHILDID_SELF)
    }

    unsafe fn describe(acc: &IAccessible, child: i32) -> Option<Element> {
        let id = VARIANT::from(child);
        let (mut l, mut t, mut w, mut h) = (0, 0, 0, 0);
        unsafe { acc.accLocation(&mut l, &mut t, &mut w, &mut h, &id) }.ok()?;
        if w <= 0 || h <= 0 {
            return None;
        }
        let role = unsafe { acc.get_accRole(&id) }
            .ok()
            .map(|mut v| {
                let inner = unsafe { &v.Anonymous.Anonymous };
                let r = if inner.vt == VT_I4 { role_name(unsafe { inner.Anonymous.lVal }) } else { String::new() };
                unsafe { clear(&mut v) };
                r
            })
            .unwrap_or_default();
        let name = unsafe { acc.get_accName(&id) }.map(|b: BSTR| b.to_string()).unwrap_or_default();
        Some(Element { rect: Rect::new(l, t, w as u32, h as u32), role, name })
    }

    unsafe fn clear(v: &mut VARIANT) {
        let _ = unsafe { VariantClear(v) };
    }

    fn role_name(role: i32) -> String {
        match role {
            ROLE_SYSTEM_STATICTEXT => "text".into(),
            0x2B => "button".into(),
            0x1E => "link".into(),
            0x28 => "graphic".into(),
            0x2A => "edit".into(),
            0x0F => "document".into(),
            0x14 => "grouping".into(),
            0x0A => "client".into(),
            0x09 => "window".into(),
            0x21 => "list".into(),
            0x22 => "listitem".into(),
            0x18 => "table".into(),
            0x1D => "cell".into(),
            0x1C => "row".into(),
            0x10 => "pane".into(),
            // Not one worth a word: an element without a name then goes unlabelled.
            _ => String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(x: i32, y: i32, w: u32, h: u32, role: &str) -> Element {
        Element { rect: Rect::new(x, y, w, h), role: role.into(), name: String::new() }
    }

    #[test]
    fn keeps_each_step_bigger_and_inside_the_window() {
        let window = Rect::new(0, 0, 1000, 800);
        let chain = vec![
            el(110, 110, 40, 12, "text"),       // the words: skipped
            el(100, 100, 80, 30, "button"),     // the button
            el(100, 100, 80, 30, "grouping"),   // same box again: skipped
            el(99, 98, 83, 33, "grouping"),     // a pixel or two around it: skipped
            el(102, 100, 3, 30, "grouping"),    // a sliver, and not around the button: skipped
            el(50, 50, 400, 300, "grouping"),   // the card
            el(-20, 0, 1100, 900, "document"),  // the page, clipped to the window
            el(0, 0, 1000, 800, "client"),      // the window: same as the clipped page, skipped
        ];
        assert_eq!(
            rects(tidy(chain, &window)),
            vec![Rect::new(100, 100, 80, 30), Rect::new(50, 50, 400, 300), Rect::new(0, 0, 1000, 800)]
        );
    }

    #[test]
    fn an_element_not_around_the_last_is_dropped() {
        let window = Rect::new(0, 0, 500, 500);
        let chain = vec![el(10, 10, 50, 50, "button"), el(200, 200, 100, 100, "grouping"), el(0, 0, 400, 400, "pane")];
        assert_eq!(rects(tidy(chain, &window)), vec![Rect::new(10, 10, 50, 50), Rect::new(0, 0, 400, 400)]);
    }

    fn rects(chain: Vec<Element>) -> Vec<Rect> {
        chain.into_iter().map(|e| e.rect).collect()
    }
}
