async function test() {
  const { GoogleGenAI, Modality } = await import("@google/genai");
  console.log("Modality:", Modality);
}
test();
