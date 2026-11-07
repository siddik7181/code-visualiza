// The examples in the picker: one per kind of picture the visualizer draws, in Python and in JavaScript. `input` is the call to run; an
// empty input runs a script as is, or gets a suggested call for code that only defines functions. The tests run every one of them.
const ex = (group, title, code, input = "", lang = "python") => ({ group, title, code: code.trim(), input: input.trim(), lang });
const js = (title, code, input = "") => ex("JavaScript", title, code, input, "javascript");

export const EXAMPLES = [
  ex(
    "Recursion",
    "Fibonacci (call tree)",
    `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
`,
    "fib(5)",
  ),
  ex(
    "Recursion",
    "Merge sort",
    `
def merge_sort(a):
    if len(a) <= 1:
        return a
    mid = len(a) // 2
    left = merge_sort(a[:mid])
    right = merge_sort(a[mid:])
    merged, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i])
            i += 1
        else:
            merged.append(right[j])
            j += 1
    return merged + left[i:] + right[j:]
`,
    "merge_sort([5, 2, 8, 1, 9, 3])",
  ),
  ex(
    "Recursion",
    "Permutations (backtracking)",
    `
def permutations(nums):
    result = []

    def backtrack(path, rest):
        if not rest:
            result.append(path)
            return
        for i in range(len(rest)):
            backtrack(path + [rest[i]], rest[:i] + rest[i + 1:])

    backtrack([], nums)
    return result
`,
    "permutations([1, 2, 3])",
  ),
  ex(
    "Recursion",
    "Binary tree depth",
    `
def max_depth(root):
    if root is None:
        return 0
    return 1 + max(max_depth(root.left), max_depth(root.right))
`,
    "max_depth(tree([3, 9, 20, None, None, 15, 7]))",
  ),
  ex(
    "Arrays",
    "Two Sum (hash map)",
    `
def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
`,
    "two_sum([3, 8, 4, 6, 11], 10)",
  ),
  ex(
    "Arrays",
    "Binary search",
    `
def binary_search(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if nums[mid] == target:
            return mid
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
`,
    "binary_search([1, 3, 4, 7, 9, 11, 15, 20], 11)",
  ),
  ex(
    "Arrays",
    "Bubble sort (bars)",
    `
def bubble_sort(a):
    n = len(a)
    for i in range(n):
        for j in range(n - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
    return a
`,
    "bubble_sort([5, 1, 4, 2, 8, 3])",
  ),
  ex(
    "Arrays",
    "Unique paths (DP grid)",
    `
def unique_paths(m, n):
    dp = [[1] * n for _ in range(m)]
    for r in range(1, m):
        for c in range(1, n):
            dp[r][c] = dp[r - 1][c] + dp[r][c - 1]
    return dp[m - 1][n - 1]
`,
    "unique_paths(3, 4)",
  ),
  ex(
    "Arrays",
    "Merge intervals",
    `
def merge(intervals):
    intervals.sort()
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
`,
    "merge([[8, 10], [1, 3], [2, 6], [15, 18]])",
  ),
  ex(
    "Structures",
    "Reverse a linked list",
    `
def reverse_list(head):
    prev = None
    while head:
        nxt = head.next
        head.next = prev
        prev, head = head, nxt
    return prev
`,
    "reverse_list(linked([1, 2, 3, 4]))",
  ),
  ex(
    "Structures",
    "BFS on a graph (queue)",
    `
def bfs(graph, start):
    seen = {start}
    queue = deque([start])
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for nxt in graph[node]:
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return order
`,
    "bfs({0: [1, 2], 1: [0, 3, 4], 2: [0, 4], 3: [1], 4: [1, 2]}, 0)",
  ),
  ex(
    "Structures",
    "Kth largest (heap)",
    `
def kth_largest(nums, k):
    heap = []
    for x in nums:
        heapq.heappush(heap, x)
        if len(heap) > k:
            heapq.heappop(heap)
    return heap[0]
`,
    "kth_largest([3, 2, 1, 5, 6, 4, 8], 3)",
  ),
  ex(
    "Structures",
    "Min stack (a class)",
    `
class MinStack:
    def __init__(self):
        self.stack = []
        self.mins = []

    def push(self, x):
        self.stack.append(x)
        if not self.mins or x <= self.mins[-1]:
            self.mins.append(x)

    def pop(self):
        if self.stack.pop() == self.mins[-1]:
            self.mins.pop()

    def get_min(self):
        return self.mins[-1]
`,
    `
s = MinStack()
s.push(5)
s.push(2)
s.push(7)
s.push(1)
s.pop()
s.get_min()
`,
  ),
  ex(
    "Structures",
    "Count set bits",
    `
def count_bits(n):
    count = 0
    while n:
        n &= n - 1
        count += 1
    return count
`,
    "count_bits(0b101101)",
  ),
  ex(
    "Any code",
    "A plain script (no input)",
    `
# Any Python runs: this is a plain script, so the input stays empty
text = "the cat and the dog and the bird"
counts = {}
for word in text.split():
    counts[word] = counts.get(word, 0) + 1
top = max(counts, key=counts.get)
print("most common:", top, counts[top])
`,
  ),
  ex(
    "Any code",
    "LeetCode class Solution (input suggested)",
    `
class Solution:
    def maxProfit(self, prices: List[int]) -> int:
        best, low = 0, float("inf")
        for p in prices:
            low = min(low, p)
            best = max(best, p - low)
        return best
`,
  ),
  js(
    "Fibonacci (call tree)",
    `
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
`,
    "fib(5)",
  ),
  js(
    "Two Sum (Map)",
    `
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
}
`,
    "twoSum([3, 8, 4, 6, 11], 10)",
  ),
  js(
    "Binary search",
    `
function binarySearch(nums, target) {
  let lo = 0, hi = nums.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (nums[mid] === target) return mid;
    if (nums[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`,
    "binarySearch([1, 3, 4, 7, 9, 11, 15, 20], 11)",
  ),
  js(
    "Bubble sort (bars)",
    `
function bubbleSort(a) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length - 1 - i; j++) {
      if (a[j] > a[j + 1]) {
        [a[j], a[j + 1]] = [a[j + 1], a[j]];
      }
    }
  }
  return a;
}
`,
    "bubbleSort([5, 1, 4, 2, 8, 3])",
  ),
  js(
    "Reverse a linked list",
    `
function reverseList(head) {
  let prev = null;
  while (head) {
    const next = head.next;
    head.next = prev;
    prev = head;
    head = next;
  }
  return prev;
}
`,
    "reverseList(linked([1, 2, 3, 4]))",
  ),
  js(
    "BFS on a graph (queue)",
    `
function bfs(graph, start) {
  const seen = new Set([start]);
  const queue = [start];
  const order = [];
  while (queue.length) {
    const node = queue.shift();
    order.push(node);
    for (const next of graph[node]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return order;
}
`,
    "bfs({0: [1, 2], 1: [0, 3, 4], 2: [0, 4], 3: [1], 4: [1, 2]}, 0)",
  ),
  js(
    "Min stack (a class)",
    `
class MinStack {
  constructor() {
    this.stack = [];
    this.mins = [];
  }
  push(x) {
    this.stack.push(x);
    if (!this.mins.length || x <= this.mins[this.mins.length - 1]) this.mins.push(x);
  }
  pop() {
    if (this.stack.pop() === this.mins[this.mins.length - 1]) this.mins.pop();
  }
  getMin() {
    return this.mins[this.mins.length - 1];
  }
}
`,
    `
const s = new MinStack();
s.push(5);
s.push(2);
s.push(7);
s.push(1);
s.pop();
s.getMin();
`,
  ),
  js(
    "A plain script (no input)",
    `
// Any JavaScript runs: this is a plain script, so the input stays empty
const text = "the cat and the dog and the bird";
const counts = {};
for (const word of text.split(" ")) {
  counts[word] = (counts[word] || 0) + 1;
}
const top = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
console.log("most common:", top, counts[top]);
`,
  ),
  js(
    "LeetCode style (input suggested)",
    `
var maxProfit = function (prices) {
  let best = 0, low = Infinity;
  for (const p of prices) {
    low = Math.min(low, p);
    best = Math.max(best, p - low);
  }
  return best;
};
`,
  ),
];
