use super::*;
use lopdf::{dictionary, Document, Object, Stream};

fn fixture(path: &Path) {
    let mut doc = Document::with_version("1.5");
    let pages = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica"});
    let resources = doc.add_object(dictionary! {"Font"=>dictionary! {"F1"=>font}});
    let mut children = Vec::new();
    for page in 1..=5 {
        let content =
            format!("0.1 0.6 0.3 rg 20 20 150 100 re f BT /F1 18 Tf 20 160 Td (Page {page}) Tj ET");
        let content = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let id = doc.add_object(dictionary! {"Type"=>"Page", "Parent"=>pages, "Contents"=>content, "Resources"=>resources, "MediaBox"=>vec![0.into(),0.into(),240.into(),200.into()]});
        children.push(Object::Reference(id));
    }
    doc.objects.insert(
        pages,
        Object::Dictionary(dictionary! {"Type"=>"Pages", "Kids"=>children, "Count"=>5}),
    );
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog", "Pages"=>pages});
    doc.trailer.set("Root", catalog);
    doc.save(path).unwrap();
}

#[tokio::test]
#[ignore = "requires Poppler pdfinfo/pdftoppm; explicitly run for visual integration"]
async fn actual_pdf_pages_render_nonblank_pixels_and_page_continuations() {
    let dir = tempfile::tempdir().unwrap();
    fixture(&dir.path().join("fixture.pdf"));
    let ctx =
        ToolContext::new(dir.path().into()).with_observations(dir.path().join("observations"));
    let first = ViewPdfTool
        .execute(&ctx, json!({"path":"fixture.pdf"}))
        .await
        .unwrap();
    assert_eq!(first["totalPages"], 5);
    assert_eq!(first["nextPage"], 4);
    assert_eq!(first["pages"].as_array().unwrap().len(), 3);
    let attachments = ViewPdfTool.output_images(&ctx, &first);
    assert_eq!(attachments.len(), 3);
    for attachment in attachments {
        let pixels = image::open(&attachment.path).unwrap().to_rgb8();
        assert!(pixels.width() >= 240);
        assert!(pixels
            .pixels()
            .any(|pixel| u16::from(pixel[1]) > u16::from(pixel[0]) + 40
                && u16::from(pixel[1]) > u16::from(pixel[2]) + 40));
        assert!(pixels.pixels().any(|pixel| pixel.0 == [255, 255, 255]));
    }
    let remaining = ViewPdfTool
        .execute(&ctx, json!({"path":"fixture.pdf", "offset":4}))
        .await
        .unwrap();
    assert_eq!(remaining["pages"].as_array().unwrap().len(), 2);
    assert!(remaining["nextPage"].is_null());
    let selected = ViewPdfTool
        .execute(&ctx, json!({"path":"fixture.pdf", "pages":"2,5"}))
        .await
        .unwrap();
    assert_eq!(selected["pages"][1]["page"], 5);
    assert!(ViewPdfTool
        .execute(&ctx, json!({"path":"fixture.pdf", "pages":"6"}))
        .await
        .is_err());
}
