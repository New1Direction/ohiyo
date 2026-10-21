//! Everyday pages: deterministic arithmetic and packing rules, no outside services.
use super::{internal, Error};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Person {
    id: String,
    name: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Expense {
    id: String,
    title: String,
    amount: String,
    paid_by: String,
    shared_by: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackItem {
    id: String,
    title: String,
    quantity: u32,
    packed: bool,
    custom: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Page {
    Bill {
        title: String,
        currency: String,
        people: Vec<Person>,
        expenses: Vec<Expense>,
    },
    Packing {
        title: String,
        nights: u32,
        weather: String,
        activities: Vec<String>,
        items: Vec<PackItem>,
    },
}

fn invalid(message: &str) -> Error {
    (StatusCode::BAD_REQUEST, message.into())
}
fn short(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max
}

pub fn initial(template: &str) -> Result<Value, Error> {
    let page = match template {
        "bill" => Page::Bill {
            title: "Our shared bill".into(),
            currency: "USD".into(),
            people: vec![
                Person {
                    id: "you".into(),
                    name: "You".into(),
                },
                Person {
                    id: "friend".into(),
                    name: "Friend".into(),
                },
            ],
            expenses: vec![],
        },
        "packing" => Page::Packing {
            title: "My next trip".into(),
            nights: 3,
            weather: "mixed".into(),
            activities: vec![],
            items: vec![],
        },
        _ => return Err(invalid("Choose a shared bill or packing list.")),
    };
    result(page, template, template == "packing")
}

fn amount_cents(amount: &str) -> Result<i64, Error> {
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
    if whole.is_empty()
        || whole.len() > 7
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || fraction.len() > 2
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(invalid(
            "Enter each amount as a number with up to two decimal places.",
        ));
    }
    let cents = whole.parse::<i64>().map_err(internal)? * 100
        + match fraction.len() {
            0 => 0,
            1 => fraction.parse::<i64>().map_err(internal)? * 10,
            _ => fraction.parse::<i64>().map_err(internal)?,
        };
    if !(1..=100_000_000).contains(&cents) {
        return Err(invalid("Each expense must be between 0.01 and 1,000,000."));
    }
    Ok(cents)
}

fn packing_items(nights: u32, weather: &str, activities: &[String]) -> Vec<PackItem> {
    let clothes = (nights + 1).min(7);
    let mut items: Vec<(&str, &str, u32)> = vec![
        ("id", "Wallet & ID", 1),
        ("phone", "Phone & charger", 1),
        ("toiletries", "Toothbrush & toiletries", 1),
        ("medication", "Any medication you take", 1),
        ("underwear", "Underwear", clothes),
        ("socks", "Socks", clothes),
        ("tops", "Tops", clothes),
        ("bottoms", "Trousers or shorts", (nights / 3 + 1).min(3)),
        ("sleep", "Sleepwear", 1),
    ];
    match weather {
        "cold" => items.extend([
            ("coat", "Warm coat", 1),
            ("layers", "Warm layers", 2),
            ("hat", "Hat & gloves", 1),
        ]),
        "warm" => items.extend([("sun", "Sunscreen & sunhat", 1)]),
        _ => items.extend([
            ("layer", "Light layer", 1),
            ("rain", "Rain jacket or umbrella", 1),
        ]),
    }
    for activity in activities {
        match activity.as_str() {
            "swimming" => items.extend([("swim", "Swimwear", 1), ("towel", "Travel towel", 1)]),
            "walking" => items.extend([
                ("shoes", "Comfortable walking shoes", 1),
                ("bottle", "Refillable water bottle", 1),
            ]),
            "going_out" => items.push(("outfit", "An outfit for going out", 1)),
            "abroad" => items.extend([
                ("passport", "Passport & required travel documents", 1),
                ("adapter", "Check whether you need a plug adapter", 1),
            ]),
            _ => {}
        }
    }
    items
        .into_iter()
        .map(|(id, title, quantity)| PackItem {
            id: id.into(),
            title: title.into(),
            quantity,
            packed: false,
            custom: false,
        })
        .collect()
}

pub fn result(mut page: Page, template: &str, rebuild: bool) -> Result<Value, Error> {
    if serde_json::to_vec(&page).map_err(internal)?.len() > 64 * 1024 {
        return Err(invalid("Keep this page under 64 KB."));
    }
    let summary = match &mut page {
        Page::Bill {
            title,
            currency,
            people,
            expenses,
        } => {
            if template != "bill" || rebuild {
                return Err(invalid("Open a shared bill to work out this split."));
            }
            if !short(title, 200)
                || !matches!(currency.as_str(), "USD" | "EUR" | "GBP")
                || !(2..=12).contains(&people.len())
                || expenses.len() > 50
            {
                return Err(invalid(
                    "Add 2–12 people and up to 50 expenses, with a title and supported currency.",
                ));
            }
            let ids: HashSet<_> = people.iter().map(|p| p.id.as_str()).collect();
            if ids.len() != people.len()
                || people
                    .iter()
                    .any(|p| !short(&p.id, 64) || !short(&p.name, 80))
            {
                return Err(invalid("Give everyone a name and a unique identity."));
            }
            let mut expense_ids = HashSet::new();
            let mut paid = vec![0i64; people.len()];
            let mut shares = vec![0i64; people.len()];
            let mut total = 0;
            for expense in expenses {
                let shared: HashSet<_> = expense.shared_by.iter().map(String::as_str).collect();
                if !short(&expense.id, 64)
                    || !expense_ids.insert(expense.id.clone())
                    || !short(&expense.title, 200)
                    || !ids.contains(expense.paid_by.as_str())
                    || shared.is_empty()
                    || shared.len() != expense.shared_by.len()
                    || shared.iter().any(|id| !ids.contains(id))
                {
                    return Err(invalid("Each expense needs a name, a payer, and at least one person sharing it. Choose each person once."));
                }
                let cents = amount_cents(&expense.amount)?;
                expense.amount = format!("{}.{:02}", cents / 100, cents % 100);
                total += cents;
                let participants: Vec<_> = people
                    .iter()
                    .enumerate()
                    .filter(|(_, p)| shared.contains(p.id.as_str()))
                    .map(|(i, _)| i)
                    .collect();
                for (order, index) in participants.iter().enumerate() {
                    shares[*index] += cents / participants.len() as i64
                        + i64::from((order as i64) < cents % participants.len() as i64);
                }
                let payer = people.iter().position(|p| p.id == expense.paid_by).unwrap();
                paid[payer] += cents;
            }
            let mut balances: Vec<_> = paid.iter().zip(&shares).map(|(p, s)| p - s).collect();
            let mut payments = Vec::new();
            for debtor in 0..people.len() {
                for creditor in 0..people.len() {
                    if balances[debtor] >= 0 || balances[creditor] <= 0 {
                        continue;
                    }
                    let cents = (-balances[debtor]).min(balances[creditor]);
                    payments.push(
                        json!({"from":people[debtor].id,"to":people[creditor].id,"cents":cents}),
                    );
                    balances[debtor] += cents;
                    balances[creditor] -= cents;
                }
            }
            json!({"total_cents":total,"people":people.iter().enumerate().map(|(i,p)|json!({"id":p.id,"paid_cents":paid[i],"share_cents":shares[i]})).collect::<Vec<_>>(),"payments":payments})
        }
        Page::Packing {
            title,
            nights,
            weather,
            activities,
            items,
        } => {
            if template != "packing"
                || !short(title, 200)
                || !(1..=30).contains(nights)
                || !matches!(weather.as_str(), "warm" | "cold" | "mixed")
                || activities.len() > 4
                || activities
                    .iter()
                    .any(|a| !matches!(a.as_str(), "swimming" | "walking" | "going_out" | "abroad"))
                || activities.iter().collect::<HashSet<_>>().len() != activities.len()
            {
                return Err(invalid(
                    "Choose 1–30 nights, a weather type, and the activities you need.",
                ));
            }
            if items.len() > 100
                || items.iter().any(|i| {
                    !short(&i.id, 64) || !short(&i.title, 200) || !(1..=99).contains(&i.quantity)
                })
                || items.iter().map(|i| &i.id).collect::<HashSet<_>>().len() != items.len()
            {
                return Err(invalid(
                    "Keep up to 100 packing items, each with a name and quantity from 1 to 99.",
                ));
            }
            if rebuild {
                let old: HashMap<_, _> = items.iter().map(|i| (i.id.clone(), i.clone())).collect();
                let mut next = packing_items(*nights, weather, activities);
                for item in &mut next {
                    item.packed = old.get(&item.id).is_some_and(|p| {
                        !p.custom
                            && p.quantity == item.quantity
                            && p.title == item.title
                            && p.packed
                    });
                }
                for custom in items.iter().filter(|i| i.custom) {
                    if next.iter().any(|i| i.id == custom.id) {
                        return Err(invalid("Give custom items their own identity."));
                    }
                    next.push(custom.clone());
                }
                if next.len() > 100 {
                    return Err(invalid(
                        "Keep up to 100 items including your personal additions.",
                    ));
                }
                *items = next;
            }
            json!({"packed":items.iter().filter(|i|i.packed).count(),"total":items.len()})
        }
    };
    Ok(json!({"page":page,"summary":summary}))
}
