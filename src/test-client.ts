import axios from "axios";

const BASE_URL = "http://localhost:3000";

async function test() {
  console.log("🧪 Testing Multi-Agent System\n");

  // Test 1: Health check
  try {
    const health = await axios.get(`${BASE_URL}/health`);
    console.log("✅ Health check:", health.data);
  } catch (error: any) {
    console.log("❌ Health check failed:", error.message);
  }

  // Test 2: Direct model test
  try {
    const test = await axios.post(`${BASE_URL}/api/test`, {
      query: "Say hello in French",
    });
    console.log("\n✅ Model test:", test.data);
  } catch (error: any) {
    console.log("❌ Model test failed:", error.message);
  }

  // Test 3: Mission
  try {
    const mission = await axios.post(`${BASE_URL}/api/mission`, {
      query: "What is the capital of France? Use wikipedia",
      threadId: `test-${Date.now()}`,
    });
    console.log("\n✅ Mission:", mission.data);
  } catch (error: any) {
    console.log("❌ Mission failed:", error.message);
    if (error.response) {
      console.log("Response:", error.response.data);
    }
  }
}

test();
