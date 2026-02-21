import axios from "axios";

const BASE_URL = "http://localhost:3000";
const API_KEY = "key1"; // Set this in production

async function testProduction() {
  console.log("🧪 Testing Production Readiness\n");

  const headers =
    process.env.NODE_ENV === "production" ? { "x-api-key": API_KEY } : {};

  // Test 1: Rate limiting
  console.log("📊 Test 1: Rate Limiting");
  for (let i = 0; i < 5; i++) {
    try {
      const start = Date.now();
      const response = await axios.get(`${BASE_URL}/health`, { headers });
      const time = Date.now() - start;
      console.log(`   Request ${i + 1}: ${time}ms - ${response.status}`);
    } catch (error: any) {
      console.log(`   Request ${i + 1}: Rate limited - ${error.message}`);
    }
  }

  // Test 2: Error handling
  console.log("\n📊 Test 2: Error Handling");
  try {
    await axios.post(`${BASE_URL}/api/mission`, {}, { headers });
  } catch (error: any) {
    console.log("   ✅ Missing query error:", error.response?.data);
  }

  // Test 3: Mission with memory
  console.log("\n📊 Test 3: Mission with Memory");
  try {
    const mission = await axios.post(
      `${BASE_URL}/api/mission`,
      {
        query: "What is machine learning?",
        threadId: `prod-test-${Date.now()}`,
      },
      { headers },
    );
    console.log(
      "   ✅ Mission completed:",
      mission.data.output.substring(0, 100) + "...",
    );
  } catch (error: any) {
    console.log("   ❌ Mission failed:", error.message);
  }

  // Test 4: Tool usage
  console.log("\n📊 Test 4: Tool Usage");
  try {
    const code = await axios.post(
      `${BASE_URL}/api/tool/code`,
      {
        code: 'console.log("Production test")',
      },
      { headers },
    );
    console.log("   ✅ Code tool:", code.data);
  } catch (error: any) {
    console.log("   ❌ Tool failed:", error.message);
  }
}

testProduction();
