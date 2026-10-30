//! What is under a point inside a window: the button, the paragraph, the panel holding them, out to
//! the window itself — so the overlay can snap to a part of a window as it snaps to windows.
//!
//! On Windows through MSAA (`IAccessible`), which every kind of app answers: Win32 and WPF ones
//! directly, browsers (Chrome, Edge, Firefox) and Electron apps for every element of the page, UWP and
//! WinUI ones through the system's bridge from UI Automation. MSAA rather than UI Automation for one
//! thing: it hit-tests inside a given window (`accHitTest`). UI Automation only finds the element at a
//! point on screen, and while picking, the point on screen is our own overlay.
//!
//! On macOS through the Accessibility API (`AXUIElement`), asked of the window's app rather than of
//! the screen — the app hit-tests its own windows, so our overlay on top doesn't get in the way. It
//! takes the *Accessibility* permission; without it every window is just the window. Linux has none
//! of this: windows only.
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

/// The elements under screen point (`x`, `y`) of the top-level window `window` (an HWND) of process
/// `pid`, innermost first and ending at the outermost the window reports. Empty when the window
/// answers nothing. Windows asks by the window, macOS by the process; each ignores the other.
#[cfg(windows)]
pub fn chain_at(window: isize, _pid: u32, x: i32, y: i32) -> Vec<Element> {
    imp::chain_at(window, x, y)
}

#[cfg(target_os = "macos")]
pub fn chain_at(_window: isize, pid: u32, x: i32, y: i32) -> Vec<Element> {
    imp::chain_at(pid, x, y)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn chain_at(_window: isize, _pid: u32, _x: i32, _y: i32) -> Vec<Element> {
    Vec::new()
}

/// Get a browser window (Chrome, Edge and the other Chromium browsers) to build the tree of its page.
/// Chromium answers with the bare window until it is told someone is reading its page, and takes
/// about a second after that. On Windows a UI Automation search for the page's document tells it; on
/// macOS, setting `AXManualAccessibility` on the app.
///
/// Browsers only, told by their executable (Windows) or their app name (macOS, `app`). Electron apps
/// are Chromium too, but some take the same signal for a screen reader starting: VS Code switches its
/// editor to screen-reader mode. Other apps answer as they are, and a search through a big app's tree
/// would cost it for nothing.
#[cfg(windows)]
pub fn wake(window: isize, _pid: u32, _app: &str) {
    imp::wake(window)
}

#[cfg(target_os = "macos")]
pub fn wake(_window: isize, pid: u32, app: &str) {
    imp::wake(pid, app)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn wake(_window: isize, _pid: u32, _app: &str) {}

/// Whether this app may ask other apps what is in their windows. Only macOS asks the person first.
pub fn has_access() -> bool {
    #[cfg(target_os = "macos")]
    return imp::trusted();
    #[cfg(not(target_os = "macos"))]
    true
}

/// macOS: have the system ask the person for the *Accessibility* permission, which reading what is in
/// other apps' windows takes. It shows its own dialog, pointing to System Settings. Elsewhere,
/// nothing.
pub fn ask_for_access() {
    #[cfg(target_os = "macos")]
    imp::ask_for_access();
}

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

#[cfg(target_os = "macos")]
mod imp {
    use super::Element;
    use crate::geometry::Rect;
    use std::ffi::c_void;
    use std::ptr::null;
    use std::sync::Once;

    type CFTypeRef = *const c_void;
    type AXError = i32;
    const AX_SUCCESS: AXError = 0;
    const AX_VALUE_CG_POINT: u32 = 1;
    const AX_VALUE_CG_SIZE: u32 = 2;
    const UTF8: u32 = 0x0800_0100;

    /// Deep enough for any real page; a cycle in a misbehaving app's tree stops here.
    const MAX_DEPTH: usize = 128;
    /// How long an app may take over each question. The default is six seconds, and a hung app
    /// would hold the overlay's asking that long for every pointer move.
    const TIMEOUT_SECONDS: f32 = 0.5;
    /// Chromium browsers, by the name their app goes by — and its Canary, Beta and Dev builds.
    const BROWSERS: &[&str] =
        &["Google Chrome", "Microsoft Edge", "Brave Browser", "Vivaldi", "Opera", "Chromium", "Arc", "Thorium"];

    #[repr(C)]
    #[derive(Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> AXError;
        fn AXUIElementCopyElementAtPosition(app: CFTypeRef, x: f32, y: f32, element: *mut CFTypeRef) -> AXError;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> AXError;
        fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: CFTypeRef) -> AXError;
        fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFTypeRef;
        fn CFStringGetLength(s: CFTypeRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(len: isize, encoding: u32) -> isize;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut u8, size: isize, encoding: u32) -> u8;
        fn CFDictionaryCreate(
            alloc: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFTypeRef;
    }

    /// A Core Foundation object this code holds a reference to, released when dropped.
    struct Owned(CFTypeRef);

    impl Owned {
        fn new(cf: CFTypeRef) -> Option<Self> {
            (!cf.is_null()).then_some(Self(cf))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }

    fn cf_string(s: &str) -> Owned {
        // Only ever called with attribute names, which always convert.
        Owned::new(unsafe { CFStringCreateWithBytes(null(), s.as_ptr(), s.len() as isize, UTF8, 0) })
            .expect("an attribute name converts to a CFString")
    }

    fn to_string(cf: CFTypeRef) -> Option<String> {
        unsafe {
            if CFGetTypeID(cf) != CFStringGetTypeID() {
                return None;
            }
            let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(cf), UTF8) + 1;
            let mut buf = vec![0u8; size.max(1) as usize];
            if CFStringGetCString(cf, buf.as_mut_ptr(), buf.len() as isize, UTF8) == 0 {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            Some(String::from_utf8_lossy(&buf[..end]).into_owned())
        }
    }

    /// The attribute names, made once per question rather than once per element asked.
    struct Names {
        parent: Owned,
        role: Owned,
        title: Owned,
        description: Owned,
        position: Owned,
        size: Owned,
    }

    impl Names {
        fn new() -> Self {
            Self {
                parent: cf_string("AXParent"),
                role: cf_string("AXRole"),
                title: cf_string("AXTitle"),
                description: cf_string("AXDescription"),
                position: cf_string("AXPosition"),
                size: cf_string("AXSize"),
            }
        }
    }

    fn attribute(element: &Owned, name: &Owned) -> Option<Owned> {
        let mut value: CFTypeRef = null();
        let err = unsafe { AXUIElementCopyAttributeValue(element.0, name.0, &mut value) };
        if err != AX_SUCCESS {
            return None;
        }
        Owned::new(value)
    }

    fn string_attribute(element: &Owned, name: &Owned) -> Option<String> {
        attribute(element, name).and_then(|v| to_string(v.0)).filter(|s| !s.trim().is_empty())
    }

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub fn ask_for_access() {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let Some(options) = Owned::new(CFDictionaryCreate(
                null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )) else {
                return;
            };
            AXIsProcessTrustedWithOptions(options.0);
        }
    }

    /// The timeout for every question this process asks, set on the system-wide element (which is
    /// what sets it for all of them).
    fn limit_waiting() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| unsafe {
            if let Some(system) = Owned::new(AXUIElementCreateSystemWide()) {
                AXUIElementSetMessagingTimeout(system.0, TIMEOUT_SECONDS);
            }
        });
    }

    pub fn chain_at(pid: u32, x: i32, y: i32) -> Vec<Element> {
        if pid == 0 || !trusted() {
            return Vec::new();
        }
        limit_waiting();
        let Some(app) = Owned::new(unsafe { AXUIElementCreateApplication(pid as i32) }) else { return Vec::new() };
        let mut hit: CFTypeRef = null();
        // The point's centre, as the overlay's frame pixel covers it.
        let err = unsafe { AXUIElementCopyElementAtPosition(app.0, x as f32 + 0.5, y as f32 + 0.5, &mut hit) };
        let Some(mut node) = Owned::new(hit).filter(|_| err == AX_SUCCESS) else { return Vec::new() };
        let names = Names::new();
        let mut chain = Vec::new();
        for _ in 0..MAX_DEPTH {
            let role = string_attribute(&node, &names.role).unwrap_or_default();
            if role == "AXApplication" {
                break;
            }
            if let Some(e) = describe(&node, &role, &names) {
                chain.push(e);
            }
            let Some(parent) = attribute(&node, &names.parent) else { break };
            node = parent;
        }
        chain
    }

    fn describe(element: &Owned, role: &str, names: &Names) -> Option<Element> {
        let mut at = CGPoint::default();
        let mut size = CGSize::default();
        let position = attribute(element, &names.position)?;
        let extent = attribute(element, &names.size)?;
        unsafe {
            if AXValueGetValue(position.0, AX_VALUE_CG_POINT, &mut at as *mut CGPoint as *mut c_void) == 0
                || AXValueGetValue(extent.0, AX_VALUE_CG_SIZE, &mut size as *mut CGSize as *mut c_void) == 0
            {
                return None;
            }
        }
        if !(size.width >= 1.0 && size.height >= 1.0) {
            return None;
        }
        // Outer edges outwards, so the box keeps the pixels its edge runs through.
        let (x0, y0) = (at.x.floor(), at.y.floor());
        let rect = Rect::new(
            x0 as i32,
            y0 as i32,
            ((at.x + size.width).ceil() - x0) as u32,
            ((at.y + size.height).ceil() - y0) as u32,
        );
        let name = string_attribute(element, &names.title)
            .or_else(|| string_attribute(element, &names.description))
            .unwrap_or_default();
        Some(Element { rect, role: role_name(role).into(), name })
    }

    pub fn wake(pid: u32, app: &str) {
        if pid == 0 || !BROWSERS.iter().any(|b| app.starts_with(b)) || !trusted() {
            return;
        }
        limit_waiting();
        let Some(element) = Owned::new(unsafe { AXUIElementCreateApplication(pid as i32) }) else { return };
        let attribute = cf_string("AXManualAccessibility");
        unsafe { AXUIElementSetAttributeValue(element.0, attribute.0, kCFBooleanTrue) };
    }

    /// The roles `tidy` and the overlay's label go by, in the words the Windows side uses.
    fn role_name(role: &str) -> &'static str {
        match role {
            "AXStaticText" => "text",
            "AXButton" | "AXPopUpButton" | "AXMenuButton" | "AXCheckBox" | "AXRadioButton" => "button",
            "AXLink" => "link",
            "AXImage" => "graphic",
            "AXTextField" | "AXTextArea" | "AXComboBox" => "edit",
            "AXWebArea" => "document",
            "AXGroup" => "grouping",
            "AXWindow" => "window",
            "AXList" | "AXOutline" => "list",
            "AXRow" => "row",
            "AXCell" => "cell",
            "AXTable" => "table",
            "AXScrollArea" | "AXSplitGroup" => "pane",
            "AXToolbar" => "toolbar",
            "AXHeading" => "heading",
            "AXTabGroup" => "tabs",
            // Not one worth a word: an element without a name then goes unlabelled.
            _ => "",
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
