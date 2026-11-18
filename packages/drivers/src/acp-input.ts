const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type ImageInput = { mediaType: string; data: string };

/** Observe the standard initialize exchange. ACPX's capability API exposes
 * controls only; no model call or native configuration write is needed here. */
export class AcpInitialization {
  #id?: string | number;
  result: Record<string, unknown> = {};

  observe(direction: string, value: unknown): void {
    const message = object(value);
    if (
      direction === "outbound" &&
      message.method === "initialize" &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      this.#id = message.id;
      this.result = {};
    } else if (
      direction === "inbound" &&
      !("method" in message) &&
      this.#id !== undefined &&
      message.id === this.#id
    ) {
      this.result = object(message.result);
      this.#id = undefined;
    }
  }

  get promptCapabilities(): { image: boolean } {
    return {
      image:
        object(object(this.result.agentCapabilities).promptCapabilities)
          .image === true,
    };
  }

  assertImages(images?: ImageInput[]): void {
    if (images?.length && !this.promptCapabilities.image)
      throw new Error("image_input_unsupported");
  }
}
