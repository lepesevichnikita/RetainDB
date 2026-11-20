//! The enqueue seam: the hook writes through `HintSink`, and the shipped
//! implementation is the atomic file queue.

mod support;

use retaindb_repo::hint::{Client, HintKind, HookHintV1, RelPath};
use retaindb_repo::queue::{Enqueue, FileQueue, HintSink};

fn read_hint(enrollment: &str, path: &str) -> HookHintV1 {
    HookHintV1 {
        enrollment_id: enrollment.to_string(),
        client: Client::Claude,
        adapter_version: Client::ADAPTER_VERSION.to_string(),
        kind: HintKind::FileRead(RelPath::parse(path).expect("valid path")),
        correlation_id: Some("toolu_sink".to_string()),
    }
}

#[test]
fn the_file_queue_satisfies_the_hint_sink_trait() {
    // A transactional backend can replace this without changing the hook.
    let harness = support::Harness::enrolled();
    let enrollment = harness.store.enrollment_id().expect("enrolled");
    let mut sink: Box<dyn HintSink> =
        Box::new(FileQueue::open(&harness.state_file("queue.json")).expect("open"));
    let outcome = sink
        .enqueue(&read_hint(&enrollment, "src/main.rs"))
        .expect("enqueue");
    assert_eq!(outcome, Enqueue::Added);
    assert_eq!(harness.queue_depth(), 1, "the sink persisted the hint");
}

#[test]
fn a_repeated_hint_through_the_trait_is_coalesced() {
    // Coalescing is queue behaviour, not hook behaviour; the seam keeps it.
    let harness = support::Harness::enrolled();
    let enrollment = harness.store.enrollment_id().expect("enrolled");
    let mut sink: Box<dyn HintSink> =
        Box::new(FileQueue::open(&harness.state_file("queue.json")).expect("open"));
    sink.enqueue(&read_hint(&enrollment, "src/main.rs"))
        .expect("first");
    let second = sink
        .enqueue(&read_hint(&enrollment, "src/main.rs"))
        .expect("second");
    assert_eq!(second, Enqueue::Coalesced);
    assert_eq!(harness.queue_depth(), 1);
}
