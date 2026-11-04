// POST /api/llm-test with x-llm-url (and optional x-llm-model): checks that the user's Colab server answers.
import { send, HttpError } from "./_db.js";
import { llmFrom } from "./_llm.js";
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); throw new HttpError(405, "Use POST."); }
    const llm = llmFrom(req);
    if (!llm) throw new HttpError(400, "Paste the Colab address first.");
    let r, d;
    try { r = await fetch(llm.url + "/v1/models", { signal: AbortSignal.timeout(20000) }); d = await r.json(); }
    catch { throw new HttpError(502, "No answer from that address. Is the notebook still running? Copy the newest address again."); }
    const models = (d.data || []).map(m => m.id);
    return res.status(200).json({ ok: true, models, hasModel: models.includes(llm.model), model: llm.model });
  } catch (e) { return send(res, e); }
}
