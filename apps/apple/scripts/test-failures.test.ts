import { expect, test } from "bun:test";
import { failureLines } from "./test-failures.ts";

test("each failure message is said with its test, from xcresulttool's tree", () => {
  const results = {
    testNodes: [
      {
        name: "Invincible",
        nodeType: "Test Plan",
        children: [
          {
            name: "InvincibleUITests",
            nodeType: "UI test bundle",
            children: [
              {
                name: "PerfTests",
                nodeType: "Test Suite",
                children: [
                  {
                    name: "testRequestsAtRest()",
                    nodeType: "Test Case",
                    children: [{ name: 'XCTAssertLessThanOrEqual failed: ("4.0") is greater than ("2.0") - At rest the app asked the node 4 times in a minute: ["4 /api/team"]', nodeType: "Failure Message" }],
                  },
                  { name: "testScrollHome()", nodeType: "Test Case", children: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(failureLines(results)).toEqual(['PerfTests.testRequestsAtRest(): XCTAssertLessThanOrEqual failed: ("4.0") is greater than ("2.0") - At rest the app asked the node 4 times in a minute: ["4 /api/team"]']);
  expect(failureLines({ testNodes: [] })).toEqual([]);
  expect(failureLines({})).toEqual([]);
});
