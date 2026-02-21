import axios from "axios";

const BASE_URL = "http://localhost:3000";

async function testAdvanced() {
  console.log("🧪 Testing Advanced Multi-Agent Features\n");

  // Test 1: Memory
  console.log("📝 Test 1: Memory Store");
  try {
    const add = await axios.post(`${BASE_URL}/api/memory/add`, {
      text: "The capital of France is Paris. It is known for the Eiffel Tower.",
      metadata: { topic: "geography" },
    });
    console.log("✅ Memory stored:", add.data);

    const recall = await axios.post(`${BASE_URL}/api/memory/recall`, {
      query: "France capital",
    });
    console.log("✅ Memory recalled:", recall.data);
  } catch (error: any) {
    console.log("❌ Memory test failed:", error.message);
  }

  // Test 2: Web Scraper
  console.log("\n📝 Test 2: Web Scraper");
  try {
    const scrape = await axios.post(`${BASE_URL}/api/tool/scrape`, {
      url: "https://example.com",
    });
    console.log("✅ Scraped:", scrape.data.result.substring(0, 200) + "...");
  } catch (error: any) {
    console.log("❌ Scraper test failed:", error.message);
  }

  // Test 3: Code Interpreter
  console.log("\n📝 Test 3: Code Interpreter");
  try {
    const code = await axios.post(`${BASE_URL}/api/tool/code`, {
      code: `
        function fibonacci(n) {
          if (n <= 1) return n;
          return fibonacci(n-1) + fibonacci(n-2);
        }
        console.log("Fibonacci(10) =", fibonacci(10));
      `,
    });
    console.log("✅ Code execution:", code.data);
  } catch (error: any) {
    console.log("❌ Code test failed:", error.message);
  }

  // Test 4: Advanced Mission with Tools
  console.log("\n📝 Test 4: Advanced Mission");
  try {
    const mission = await axios.post(`${BASE_URL}/api/mission`, {
      query:
        "Explain what a recursive function is and provide a simple example",
      tools: ["scraper", "code"],
      threadId: `adv-test-${Date.now()}`,
    });
    console.log("✅ Mission result:", mission.data);
  } catch (error: any) {
    console.log("❌ Mission failed:", error.message);
  }

  // Test 5: Complex Multi-Phase Mission
  console.log("\n📝 Test 5: Complex Mission");
  try {
    const complex = await axios.post(`${BASE_URL}/api/mission/complex`, {
      query: "Machine Learning",
      threadId: `complex-${Date.now()}`,
    });
    console.log("✅ Complex mission:", {
      answer: complex.data.answer?.substring(0, 200) + "...",
      hasResearch: !!complex.data.research,
      hasAnalysis: !!complex.data.analysis,
    });
  } catch (error: any) {
    console.log("❌ Complex mission failed:", error.message);
  }
}

testAdvanced();
