use super::BrowserBounds;

#[cfg(target_os = "macos")]
use tauri::Manager;

pub(crate) fn viewport_bounds(
    app: &tauri::AppHandle,
    bounds: BrowserBounds,
) -> Result<BrowserBounds, String> {
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or_else(|| "找不到 miniQ 主页面".to_string())?;
        let scale = main
            .window()
            .scale_factor()
            .map_err(|error| error.to_string())?;
        let main_bounds = main.bounds().map_err(|error| error.to_string())?;
        Ok(relative_to_main(bounds, main_bounds.position, scale))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(bounds)
    }
}

#[cfg(any(target_os = "macos", test))]
fn relative_to_main(bounds: BrowserBounds, position: tauri::Position, scale: f64) -> BrowserBounds {
    let origin = position.to_logical::<f64>(scale);
    // index.html uses viewport-fit=cover: DOM client rects already include the
    // titlebar safe area. Add only the main view's origin, or child views move
    // down by the inset and their bottom edge extends beyond the window.
    BrowserBounds {
        x: origin.x + bounds.x,
        y: origin.y + bounds.y,
        ..bounds
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, PhysicalPosition};

    #[test]
    fn full_height_site_starts_below_toolbar_and_ends_at_window_bottom() {
        assert!(include_str!("../../index.html").contains("viewport-fit=cover"));
        for (width, height) in [(800.0, 600.0), (1200.0, 800.0), (1600.0, 1000.0)] {
            for scale in [1.0, 2.0] {
                let result = relative_to_main(
                    BrowserBounds {
                        x: 0.0,
                        y: 44.0,
                        width,
                        height: height - 44.0,
                    },
                    PhysicalPosition::new(0, 0).into(),
                    scale,
                );
                assert_eq!(result.x, 0.0);
                assert_eq!(result.y, 44.0);
                assert_eq!(result.width, width);
                assert_eq!(result.y + result.height, height);
            }
        }
    }

    #[test]
    fn converts_main_origin_once_without_scaling_dom_dimensions() {
        let panel = BrowserBounds {
            x: 100.0,
            y: 44.0,
            width: 700.0,
            height: 556.0,
        };
        for position in [
            LogicalPosition::new(8.0, 24.0).into(),
            PhysicalPosition::new(16, 48).into(),
        ] {
            let result = relative_to_main(panel, position, 2.0);
            assert_eq!((result.x, result.y), (108.0, 68.0));
            assert_eq!((result.width, result.height), (700.0, 556.0));
        }
    }

    #[test]
    fn follows_main_origin_when_entering_fullscreen() {
        let panel = BrowserBounds {
            x: 0.0,
            y: 44.0,
            width: 1200.0,
            height: 756.0,
        };
        let windowed = relative_to_main(panel, LogicalPosition::new(0.0, 24.0).into(), 2.0);
        let fullscreen = relative_to_main(panel, LogicalPosition::new(0.0, 0.0).into(), 2.0);
        assert_eq!(windowed.y, 68.0);
        assert_eq!(fullscreen.y, 44.0);
        assert_eq!(windowed.height, fullscreen.height);
    }
}
