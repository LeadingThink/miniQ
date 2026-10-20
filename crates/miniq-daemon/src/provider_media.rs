//! Use the same private media transport for tool references and chat images.
use std::sync::Arc;

use miniq_tools::{MediaConfig, ProviderMediaUploader};
use tokio_util::sync::CancellationToken;

pub(crate) fn for_media(
    media: &MediaConfig,
    cancel: CancellationToken,
) -> Option<Arc<dyn ProviderMediaUploader>> {
    miniq_models::provider_media_uploader(&media.base_url, &media.api_key, cancel)
}
