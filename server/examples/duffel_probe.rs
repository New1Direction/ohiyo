//! Deliberately no booking-create, cancellation, charge or SQLite calls.
//! Run only on explicit operator request; normal tests never execute this example.
use server::api::burrow::travel::{
    duffel::{Duffel, DuffelHttp, Stays},
    Mandate,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len()==4,"usage: duffel_probe <mandate.json> <latitude> <longitude>; reads DUFFEL_ACCESS_TOKEN privately from environment");
    let token = std::env::var("DUFFEL_ACCESS_TOKEN").map_err(|_| {
        anyhow::anyhow!(
            "missing DUFFEL_ACCESS_TOKEN; configure privately, never paste a token into a thread"
        )
    })?;
    let mandate: Mandate = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let p = Duffel::new(DuffelHttp::new(token)?);
    let search = p
        .search(&mandate, args[2].parse()?, args[3].parse()?)
        .await?;
    println!(
        "search: {} results; request {:?}",
        search.value.len(),
        search.evidence.provider_request_id
    );
    let mut selected = None;
    for option in search.value.iter().take(3) {
        let rates = p.rates(&option.search_result_id).await?;
        println!(
            "rates: {}; request {:?}",
            rates.value.len(),
            rates.evidence.provider_request_id
        );
        if let Some(rate) = rates
            .value
            .into_iter()
            .find(|r| mandate.evaluate(r, server::types::now_unix()).is_ok())
        {
            selected = Some(rate);
            break;
        }
    }
    let rate = selected.ok_or_else(|| {
        anyhow::anyhow!("no policy-compliant rate in first three properties; no booking attempted")
    })?;
    let quote = p.quote(&rate.rate_id).await?;
    mandate.evaluate(&quote.value, server::types::now_unix())?;
    println!(
        "fresh quote (NOT a booking): {}",
        serde_json::to_string_pretty(&quote.value)?
    );
    println!("quote request {:?}", quote.evidence.provider_request_id);
    // Read-only reconciliation capability probe: never print other customers' data.
    let list = p.list(None).await?;
    println!(
        "booking-list read available: {} rows on first page; request {:?}",
        list.value.bookings.len(),
        list.evidence.provider_request_id
    );
    println!("STOPPED before purchase. Booking-create permission, commercial activation, actual balance and settlement are NOT proven by this probe.");
    Ok(())
}
