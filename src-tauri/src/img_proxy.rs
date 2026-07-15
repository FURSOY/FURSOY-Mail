// Remote email image proxy.
//
// The frontend rewrites remote image URLs to the local `mailimg` protocol. This
// handler fetches the bytes so the mail iframe does not make direct web requests.
// Every destination is validated to prevent a message from using the app as a
// request proxy for the user's local network.

use futures::StreamExt;
use reqwest::{header, redirect::Policy, Client, Url};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// Maximum image size we are willing to keep in memory.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, _, _] = address.octets();
    !address.is_private()
        && !address.is_loopback()
        && !address.is_link_local()
        && !address.is_multicast()
        && !address.is_unspecified()
        && !address.is_broadcast()
        && !address.is_documentation()
        && first != 0
        && !(first == 100 && (64..=127).contains(&second))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => {
            let octets = address.octets();
            // Reject IPv4-compatible and IPv4-mapped addresses using the same
            // rules as native IPv4 addresses (for example ::ffff:127.0.0.1).
            if octets[..12].iter().all(|byte| *byte == 0)
                || (octets[..10].iter().all(|byte| *byte == 0)
                    && octets[10] == 0xff
                    && octets[11] == 0xff)
            {
                return is_public_ipv4(Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                ));
            }

            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_unique_local()
                && !address.is_unicast_link_local()
                && !(address.segments()[0] == 0x2001 && address.segments()[1] == 0x0db8)
        }
    }
}

async fn resolve_public_target(target: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    if !matches!(target.scheme(), "http" | "https") {
        return Err("unsupported scheme".to_string());
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err("credentials are not allowed".to_string());
    }

    let host = target
        .host_str()
        .ok_or_else(|| "missing image host".to_string())?
        .to_string();
    let port = target
        .port_or_known_default()
        .ok_or_else(|| "missing image port".to_string())?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| "could not resolve image host".to_string())?
        .collect();

    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("image host is not publicly routable".to_string());
    }

    Ok((host, addresses))
}

fn is_allowed_image_content_type(content_type: &str) -> bool {
    matches!(
        content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/x-icon"
    )
}

fn image_client(host: &str, addresses: &[SocketAddr]) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) FURSOYMail/1.0");
    for address in addresses {
        builder = builder.resolve(host, *address);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Fetch a remote image referenced by a `mailimg://` request URI.
/// Returns the raw bytes and the verified image content type.
pub async fn fetch_remote_image(request_uri: String) -> Result<(Vec<u8>, String), String> {
    let parsed = Url::parse(&request_uri).map_err(|e| format!("bad proxy uri: {e}"))?;
    let target = parsed
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "missing url parameter".to_string())?;
    let mut target = Url::parse(&target).map_err(|_| "invalid image URL".to_string())?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve_public_target(&target).await?;
        let client = image_client(&host, &addresses)?;
        let response = client
            .get(target.clone())
            .header(header::ACCEPT, "image/*")
            .send()
            .await
            .map_err(|_| "image fetch failed".to_string())?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("too many image redirects".to_string());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "image redirect is missing a location".to_string())?;
            target = target
                .join(location)
                .map_err(|_| "invalid image redirect".to_string())?;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("upstream status {}", response.status()));
        }

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !is_allowed_image_content_type(&content_type) {
            return Err("unsupported image content type".to_string());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_IMAGE_BYTES as u64)
        {
            return Err("image too large".to_string());
        }

        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "image download failed".to_string())?;
            if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
                return Err("image too large".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }

        return Ok((bytes, content_type));
    }

    Err("too many image redirects".to_string())
}

#[cfg(test)]
mod tests {
    use super::is_public_ip;

    #[test]
    fn rejects_local_and_private_addresses() {
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("192.168.1.10".parse().unwrap()));
        assert!(!is_public_ip("169.254.10.20".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("fd00::1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
    }
}
