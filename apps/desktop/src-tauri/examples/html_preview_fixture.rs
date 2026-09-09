//! Isolated local-resource acceptance page. Never reads user workspaces.
#[path = "../src/html_preview.rs"]
#[allow(dead_code)]
mod html_preview;
#[path = "../src/local_file.rs"]
#[allow(dead_code)]
mod local_file;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = tempfile::tempdir()?;
    std::fs::create_dir(fixture.path().join("assets"))?;
    for (path, content) in [
        ("index.html", "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>miniQ local resource acceptance</title><link rel=\"stylesheet\" href=\"assets/style.css\"><main><img src=\"assets/logo.png\" width=\"96\" height=\"96\" alt=\"miniQ\"><h1>Local resource acceptance</h1><p id=\"result\">Loading data</p><button id=\"action\">Increment</button><output id=\"count\">0</output></main><script type=\"module\" src=\"assets/main.js\"></script></html>"),
        ("assets/style.css", "body{margin:0;padding:24px;background:#eef2f1;color:#14201c;font:16px system-ui}main{max-width:640px;margin:auto}h1{font-size:24px}button{margin-right:16px;border:0;border-radius:6px;background:#196957;color:white;padding:10px 16px}output{font-variant-numeric:tabular-nums}"),
        ("assets/main.js", "import {step} from './step.js'; const data=await fetch('./assets/data.json').then(r=>r.json()); document.querySelector('#result').textContent=data.message; let count=0; document.querySelector('#action').addEventListener('click',()=>document.querySelector('#count').textContent=String(count+=step));"),
        ("assets/step.js", "export const step=1;"),
        ("assets/data.json", "{\"message\":\"CSS, module imports, JSON and image loaded\"}"),
    ] { std::fs::write(fixture.path().join(path), content)?; }
    std::fs::write(
        fixture.path().join("assets/logo.png"),
        include_bytes!("../icons/icon.png"),
    )?;
    let previews = html_preview::HtmlPreviews::default();
    let handle = previews
        .open(
            "index.html",
            fixture.path().to_str().ok_or("non-UTF8 fixture path")?,
            &[],
            false,
        )
        .await?;
    println!("{}", serde_json::to_string(&handle)?);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
