// pptx-preview owns a global chart event bus. Its lifetimes must not overlap.
let ownerReleased = Promise.resolve();

export async function acquirePresentationRenderer(): Promise<() => void> {
  const previous = ownerReleased;
  let release!: () => void;
  ownerReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}
