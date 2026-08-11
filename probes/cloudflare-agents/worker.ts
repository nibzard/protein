import { Agent, type Connection, type WSMessage } from "agents";

interface Env {
  PROBE: DurableObjectNamespace<ProbeAgent>;
}

interface ProbeState {
  count: number;
  scheduledCount: number;
}

export class ProbeAgent extends Agent<Env, ProbeState> {
  initialState: ProbeState = { count: 0, scheduledCount: 0 };

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/increment")) {
      this.setState({ ...this.state, count: this.state.count + 1 });
    }

    if (url.pathname.endsWith("/schedule")) {
      const schedule = await this.schedule(
        1,
        "scheduledIncrement",
        { delta: 2 },
        { idempotent: true },
      );
      return Response.json({ schedule });
    }

    return Response.json({
      agent: this.name,
      count: this.state.count,
      scheduledCount: this.state.scheduledCount,
    });
  }

  async scheduledIncrement(payload: { delta: number }): Promise<void> {
    this.setState({
      ...this.state,
      count: this.state.count + payload.delta,
      scheduledCount: (this.state.scheduledCount ?? 0) + 1,
    });
  }

  override onConnect(connection: Connection): void {
    connection.send(JSON.stringify({ type: "connected", state: this.state }));
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    connection.send(JSON.stringify({ type: "echo", message }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "compatibility-probe";
    const id = env.PROBE.idFromName(name);
    return env.PROBE.get(id).fetch(request);
  },
};
