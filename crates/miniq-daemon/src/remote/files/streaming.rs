//! Integrity is checked incrementally, before the caller publishes any destination.
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncWrite, AsyncWriteExt};
pub(super) async fn receive<S, B, E, W>(
    mut stream: S,
    writer: &mut W,
    expected: u64,
    hash: &str,
) -> Result<(), String>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    W: AsyncWrite + Unpin,
{
    let mut size = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "File retrieval failed")?;
        let bytes = chunk.as_ref();
        size = size
            .checked_add(bytes.len() as u64)
            .ok_or("File exceeds declared size")?;
        if size > expected || size > super::MAX_BYTES {
            return Err("File exceeds declared size".into());
        }
        digest.update(bytes);
        writer
            .write_all(bytes)
            .await
            .map_err(|_| "Cannot write file")?;
    }
    if size != expected || format!("{:x}", digest.finalize()) != hash {
        return Err("File integrity verification failed".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preserves_arbitrary_bytes_and_verifies_chunked_hash() {
        let data = b"\x00\xff\r\nhello";
        let hash = format!("{:x}", Sha256::digest(data));
        let mut output = Vec::new();
        let stream =
            futures_util::stream::iter([Ok::<_, ()>(data[..3].to_vec()), Ok(data[3..].to_vec())]);
        receive(stream, &mut output, data.len() as u64, &hash)
            .await
            .unwrap();
        assert_eq!(output, data);
    }
    #[tokio::test]
    async fn rejects_corruption_truncation_oversize_and_stream_errors() {
        for (chunks, size, hash) in [
            (vec![Ok(b"abc".to_vec())], 3, "0".repeat(64)),
            (
                vec![Ok(b"ab".to_vec())],
                3,
                format!("{:x}", Sha256::digest(b"abc")),
            ),
            (
                vec![Ok(b"abcd".to_vec())],
                3,
                format!("{:x}", Sha256::digest(b"abc")),
            ),
            (vec![Err(())], 0, format!("{:x}", Sha256::digest(b""))),
        ] {
            assert!(receive(
                futures_util::stream::iter(chunks),
                &mut Vec::new(),
                size,
                &hash
            )
            .await
            .is_err());
        }
    }
}
