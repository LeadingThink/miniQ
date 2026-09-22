//! Scheduled tasks: a background loop sends due prompts through the normal
//! turn pipeline (same risk gating / approvals as interactive turns), either
//! in a fresh session or as a heartbeat of one explicitly selected session.
//!
//! Schedule spec (stored as JSON on the task row), times in local wall clock:
//!   {"type":"daily","time":"09:00"}
//!   {"type":"weekly","weekday":1,"time":"09:00"}   // 1 = Monday .. 7 = Sunday
//!   {"type":"weekdays","weekdays":[1,2,3,4,5],"time":"09:00"}
//!   {"type":"interval","minutes":30}

use miniq_protocol::{Event, ScheduledTask, ScheduledTaskMode, SessionStatus};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime, UtcOffset, Weekday};

use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Schedule {
    /// Every day at `time` ("HH:MM", local).
    Daily { time: ScheduleTime },
    /// Every week on `weekday` (1 = Monday .. 7 = Sunday) at `time` (local).
    Weekly { weekday: u8, time: ScheduleTime },
    /// Weekdays (1 = Monday .. 7 = Sunday) at a local wall-clock time.
    Weekdays {
        weekdays: Vec<u8>,
        time: ScheduleTime,
    },
    /// Every `minutes` minutes, from the last run.
    Interval { minutes: u32 },
}

/// "HH:MM" wall-clock time, validated on parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleTime {
    pub hour: u8,
    pub minute: u8,
}

impl Serialize for ScheduleTime {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:02}:{:02}", self.hour, self.minute))
    }
}

impl<'de> Deserialize<'de> for ScheduleTime {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        let (h, m) = raw
            .split_once(':')
            .ok_or_else(|| serde::de::Error::custom("time must be HH:MM"))?;
        let hour: u8 = h.parse().map_err(serde::de::Error::custom)?;
        let minute: u8 = m.parse().map_err(serde::de::Error::custom)?;
        if hour > 23 || minute > 59 {
            return Err(serde::de::Error::custom("time out of range"));
        }
        Ok(ScheduleTime { hour, minute })
    }
}

/// Parse and validate a schedule spec from its JSON form.
pub fn parse_schedule(value: &serde_json::Value) -> Result<Schedule, String> {
    let schedule: Schedule =
        serde_json::from_value(value.clone()).map_err(|e| format!("invalid schedule: {e}"))?;
    match schedule {
        Schedule::Weekly { weekday, .. } if !(1..=7).contains(&weekday) => {
            Err("weekday must be 1 (Monday) .. 7 (Sunday)".to_string())
        }
        Schedule::Weekdays { weekdays, .. }
            if weekdays.is_empty() || weekdays.iter().any(|day| !(1..=7).contains(day)) =>
        {
            Err("weekdays must contain at least one day from 1 (Monday) .. 7 (Sunday)".to_string())
        }
        Schedule::Interval { minutes } if !(1..=7 * 24 * 60).contains(&(minutes as usize)) => {
            Err("interval minutes must be between 1 and 10080".to_string())
        }
        other => Ok(other),
    }
}

fn local_offset() -> UtcOffset {
    UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC)
}

fn weekday_number(weekday: Weekday) -> u8 {
    match weekday {
        Weekday::Monday => 1,
        Weekday::Tuesday => 2,
        Weekday::Wednesday => 3,
        Weekday::Thursday => 4,
        Weekday::Friday => 5,
        Weekday::Saturday => 6,
        Weekday::Sunday => 7,
    }
}

/// Next fire time strictly after `now`, returned as UTC.
pub fn next_run_after(schedule: &Schedule, now_utc: OffsetDateTime) -> OffsetDateTime {
    let offset = local_offset();
    let local = now_utc.to_offset(offset);
    let next_local = match schedule {
        Schedule::Interval { minutes } => local + Duration::minutes(*minutes as i64),
        Schedule::Daily { time } => {
            let today = local
                .replace_hour(time.hour)
                .and_then(|t| t.replace_minute(time.minute))
                .and_then(|t| t.replace_second(0))
                .and_then(|t| t.replace_nanosecond(0))
                .unwrap_or(local);
            if today > local {
                today
            } else {
                today + Duration::days(1)
            }
        }
        Schedule::Weekly { weekday, time } => {
            let at_time = local
                .replace_hour(time.hour)
                .and_then(|t| t.replace_minute(time.minute))
                .and_then(|t| t.replace_second(0))
                .and_then(|t| t.replace_nanosecond(0))
                .unwrap_or(local);
            let today_num = weekday_number(local.weekday());
            let mut days_ahead = (*weekday as i64) - (today_num as i64);
            if days_ahead < 0 || (days_ahead == 0 && at_time <= local) {
                days_ahead += 7;
            }
            at_time + Duration::days(days_ahead)
        }
        Schedule::Weekdays { weekdays, time } => {
            let at_time = local
                .replace_hour(time.hour)
                .and_then(|t| t.replace_minute(time.minute))
                .and_then(|t| t.replace_second(0))
                .and_then(|t| t.replace_nanosecond(0))
                .unwrap_or(local);
            let today_num = weekday_number(local.weekday());
            let days_ahead = (0..=7)
                .find(|offset| {
                    let candidate = (today_num as i64 + *offset - 1) % 7 + 1;
                    weekdays.contains(&(candidate as u8)) && (*offset > 0 || at_time > local)
                })
                .unwrap_or(7);
            at_time + Duration::days(days_ahead)
        }
    };
    next_local.to_offset(UtcOffset::UTC)
}

/// RFC3339 UTC string for the next fire time after `now`.
pub fn next_run_iso(schedule: &Schedule, now_utc: OffsetDateTime) -> String {
    next_run_after(schedule, now_utc)
        .format(&Rfc3339)
        .unwrap_or_else(|_| miniq_memory::now_iso())
}

/// Run a task manually. Paused tasks may run once without being enabled.
pub fn fire_task(state: &AppState, task: &ScheduledTask) -> Result<String, String> {
    dispatch_task(state, task, false)
}

fn dispatch_task(
    state: &AppState,
    snapshot: &ScheduledTask,
    only_due: bool,
) -> Result<String, String> {
    let _activity = state.activity.enter().map_err(|error| error.message)?;
    let due_at = only_due.then_some(snapshot.next_run_at.as_str());
    if !state
        .store
        .claim_scheduled_task(&snapshot.id, due_at)
        .map_err(|e| e.to_string())?
    {
        return Err("任务正在运行，或本次计划已经处理，将等待下一次执行".into());
    }
    let result = state
        .store
        .get_scheduled_task(&snapshot.id)
        .map_err(|e| e.to_string())
        .and_then(|task| dispatch_claimed_task(state, &task));
    if result.is_err() {
        let _ = state.store.release_scheduled_task(&snapshot.id);
    }
    result
}

fn dispatch_claimed_task(state: &AppState, task: &ScheduledTask) -> Result<String, String> {
    let schedule = parse_schedule(&task.schedule).map_err(|error| {
        let _ = state
            .store
            .set_scheduled_task_enabled(&task.id, false, None);
        error
    })?;
    let session = match task.mode {
        ScheduledTaskMode::NewSession => state
            .store
            .create_session(&task.workspace_id, &task.name)
            .map_err(|e| e.to_string())?,
        ScheduledTaskMode::Heartbeat => {
            let id = task
                .target_session_id
                .as_deref()
                .ok_or("heartbeat task has no target session")?;
            let session = state.store.get_session(id).map_err(|e| match e {
                miniq_memory::MemoryError::NotFound(_) => {
                    let _ = state
                        .store
                        .set_scheduled_task_enabled(&task.id, false, None);
                    "目标会话已删除，任务已暂停；请编辑任务并选择新会话".to_string()
                }
                other => other.to_string(),
            })?;
            if session.workspace_id != task.workspace_id {
                return Err("heartbeat target belongs to another workspace".into());
            }
            if session.archived || session.external.is_some() {
                return Err("目标会话已归档或为导入记录，请选择可继续的会话".into());
            }
            if !matches!(session.status, SessionStatus::Idle | SessionStatus::Failed) {
                return Err("heartbeat target session is active or awaiting approval".into());
            }
            session
        }
    };

    let Some(cancel) = state.begin_turn(&session.id) else {
        return Err("session already has an active turn".to_string());
    };

    let content = if task.memory.trim().is_empty() {
        task.prompt.clone()
    } else {
        format!("{}\n\n任务记忆：\n{}", task.prompt, task.memory.trim())
    };
    let next_run = next_run_iso(&schedule, OffsetDateTime::now_utc());
    let message =
        match state
            .store
            .start_scheduled_task_run(&task.id, &session.id, &content, &next_run)
        {
            Ok(m) => m,
            Err(e) => {
                state.end_turn(&session.id);
                return Err(e.to_string());
            }
        };
    state.emit(Event::MessageCreated {
        session_id: session.id.clone(),
        message,
    });
    state.emit(Event::SessionStatusChanged {
        session_id: session.id.clone(),
        status: SessionStatus::Running,
    });
    crate::turn::spawn_turn(state.clone(), session.id.clone(), cancel);
    Ok(session.id)
}

async fn run_due_tasks(state: &AppState) {
    let Ok(_activity) = state.activity.enter() else {
        return;
    };
    let now = miniq_memory::now_iso();
    let due = match state.store.due_scheduled_tasks(&now) {
        Ok(due) => due,
        Err(e) => {
            tracing::error!("scheduler: listing due tasks failed: {e}");
            return;
        }
    };
    for task in due {
        match dispatch_task(state, &task, true) {
            Ok(session_id) => {
                tracing::info!(
                    "scheduler: fired task {} ({}), session {session_id}",
                    task.id,
                    task.name
                );
            }
            Err(e) => {
                // A target awaiting approval or an active turn is skipped for
                // this occurrence; do not hammer it every scheduler tick.
                if let Ok(schedule) = parse_schedule(&task.schedule) {
                    let next = next_run_iso(&schedule, OffsetDateTime::now_utc());
                    let _ = state
                        .store
                        .defer_scheduled_task(&task.id, &task.next_run_at, &next);
                }
                tracing::debug!("scheduler: task {} postponed: {e}", task.id);
            }
        }
    }
}

/// Background scheduler loop. Checks for due tasks every 30 seconds; runs one
/// pass at startup so overdue tasks fire without waiting a full tick.
pub fn spawn_scheduler(state: AppState) {
    if let Err(error) = state.store.recover_scheduled_task_claims() {
        tracing::error!("scheduler: recovering interrupted dispatch failed: {error}");
        return;
    }
    tokio::spawn(async move {
        tracing::info!("scheduler started");
        run_due_tasks(&state).await;
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            run_due_tasks(&state).await;
        }
    });
}

#[cfg(test)]
mod continuity_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use time::macros::datetime;

    #[test]
    fn parses_all_schedule_kinds() {
        assert!(matches!(
            parse_schedule(&json!({"type": "daily", "time": "09:30"})),
            Ok(Schedule::Daily { .. })
        ));
        assert!(matches!(
            parse_schedule(&json!({"type": "weekdays", "weekdays": [1, 3, 5], "time": "08:00"})),
            Ok(Schedule::Weekdays { .. })
        ));
        assert!(matches!(
            parse_schedule(&json!({"type": "weekly", "weekday": 1, "time": "08:00"})),
            Ok(Schedule::Weekly { .. })
        ));
        assert!(matches!(
            parse_schedule(&json!({"type": "interval", "minutes": 30})),
            Ok(Schedule::Interval { minutes: 30 })
        ));
        assert!(parse_schedule(&json!({"type": "daily", "time": "25:00"})).is_err());
        assert!(parse_schedule(&json!({"type": "weekly", "weekday": 8, "time": "08:00"})).is_err());
        assert!(parse_schedule(&json!({"type": "interval", "minutes": 0})).is_err());
        assert!(parse_schedule(&json!({"type": "cron", "expr": "* * * * *"})).is_err());
    }

    #[test]
    fn interval_next_run() {
        let now = datetime!(2026-07-06 10:00:00 UTC);
        let next = next_run_after(&Schedule::Interval { minutes: 45 }, now);
        assert_eq!(next - now, Duration::minutes(45));
    }

    #[test]
    fn daily_next_run_is_in_future() {
        let now = OffsetDateTime::now_utc();
        for (hour, minute) in [(0u8, 0u8), (9, 30), (23, 59)] {
            let schedule = Schedule::Daily {
                time: ScheduleTime { hour, minute },
            };
            let next = next_run_after(&schedule, now);
            assert!(
                next > now,
                "daily {hour:02}:{minute:02} must be in the future"
            );
            assert!(next - now <= Duration::days(1) + Duration::minutes(1));
        }
    }

    #[test]
    fn weekly_next_run_lands_on_requested_weekday() {
        let now = OffsetDateTime::now_utc();
        for weekday in 1u8..=7 {
            let schedule = Schedule::Weekly {
                weekday,
                time: ScheduleTime {
                    hour: 12,
                    minute: 0,
                },
            };
            let next = next_run_after(&schedule, now);
            assert!(next > now);
            assert!(next - now <= Duration::days(7) + Duration::minutes(1));
            let local = next.to_offset(local_offset());
            assert_eq!(weekday_number(local.weekday()), weekday);
            assert_eq!(local.hour(), 12);
        }
    }

    #[test]
    fn schedule_time_roundtrip() {
        let t: ScheduleTime = serde_json::from_value(json!("07:05")).unwrap();
        assert_eq!((t.hour, t.minute), (7, 5));
        assert_eq!(serde_json::to_value(t).unwrap(), json!("07:05"));
        assert!(serde_json::from_value::<ScheduleTime>(json!("7")).is_err());
    }
}
