import { describe, expect, test } from "bun:test";
import { docChecks, staleDocChecks } from "../src/shared/docChecks";
import {
	assembleDeploymentManifestMarkdown,
	assembleDeploymentRunbook,
	assembleReleaseBundleCsv,
	assembleReleaseBundleMarkdown,
	assembleRtmCsv,
	assembleRtmMarkdown,
	assembleTestExecutionProtocol,
	assembleTicketPacketMarkdown,
	buildRtmRows,
	detectChecksumDrift,
	evaluateTicketReadiness,
	isTestRunStale,
	orderSqlTablesTopologically,
	parseTestRunDocument,
} from "../src/shared/docExport";
import { withLinkFiles } from "../src/shared/docLinks";
import { checkTables } from "../src/shared/docTables";
import { addToFrontMatterList, frontMatter, one, withFrontMatter } from "../src/shared/frontMatter";
import { withNames } from "../src/shared/namedLinks";
import { frontValue, toneOf } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { diffSqlAgainstSchemaMarkdown, mergeSqlTablesIntoMarkdown, parseCreateTables } from "../src/shared/sqlSchema";
import { isPlanPath, parsePlan, printPlan } from "../src/view/plan/model";

const sampleDoc = (overrides: Partial<DocFile>): DocFile => ({
	path: "/ws/docs/tickets/LIMS-100.md",
	name: "LIMS-100.md",
	group: "tickets",
	exists: true,
	...overrides,
});

describe("Round 6 Wave 1.4 — Schema sync target-doc & markDropped parity", () => {
	const ddl = [
		"CREATE TABLE dbo.SAMPLE_BATCH (",
		"\tBATCH_ID INT NOT NULL PRIMARY KEY,",
		"\tSAMPLE_CODE NVARCHAR(50) NOT NULL,",
		"\tSTATUS_FLAG NVARCHAR(20) NULL",
		");",
		"GO",
		"ALTER TABLE dbo.SAMPLE_BATCH ADD CONSTRAINT FK_BATCH_CLIENT",
		"\tFOREIGN KEY (SAMPLE_CODE) REFERENCES dbo.CLIENT_REGISTRY (CLIENT_CODE);",
		"GO",
		"COMMENT ON COLUMN dbo.SAMPLE_BATCH.BATCH_ID IS 'Primary batch identifier';",
	].join("\n");

	test("parseCreateTables extracts SSMS FKs and column comments", () => {
		const tables = parseCreateTables(ddl, { includeStandaloneAlter: true });
		expect(tables).toHaveLength(1);
		const tbl = tables[0]!;
		expect(tbl.tableName).toBe("SAMPLE_BATCH");
		expect(tbl.foreignKeys?.some((fk) => fk.refTable.toUpperCase().includes("CLIENT_REGISTRY"))).toBe(true);
		const batchCol = tbl.columns.find((c) => c.name === "BATCH_ID");
		expect(batchCol?.comment).toContain("Primary batch identifier");
	});

	test("diffSqlAgainstSchemaMarkdown ignores already-tagged deprecated/dropped rows", () => {
		const existingMd = [
			"# SAMPLE_BATCH",
			"",
			"## Columns",
			"",
			"| Column | Type | Nullable | Notes |",
			"| --- | --- | --- | --- |",
			"| `BATCH_ID` | `INT` | No | PK |",
			"| `SAMPLE_CODE` | `NVARCHAR(50)` | No | Existing note |",
			"| `STATUS_FLAG` | `NVARCHAR(20)` | Yes | Active flag |",
			"| `LEGACY_COL` | `NVARCHAR(10)` | Yes | Old field [deprecated / dropped in SQL] |",
			"| `FRESHLY_DROPPED` | `INT` | Yes | Still documented |",
			"",
		].join("\n");

		const drifts = diffSqlAgainstSchemaMarkdown(ddl, existingMd);
		expect(drifts).toHaveLength(1);
		expect(drifts[0]!.dropped).toEqual(["FRESHLY_DROPPED"]);
		expect(drifts[0]!.dropped).not.toContain("LEGACY_COL");
	});

	test("mergeSqlTablesIntoMarkdown respects markDropped: false vs markDropped: true", () => {
		const existingMd = [
			"## SAMPLE_BATCH",
			"",
			"| Column | Type | Constraints | Notes |",
			"| --- | --- | --- | --- |",
			"| `BATCH_ID` | `INT` | NOT NULL PRIMARY KEY | Custom analyst note |",
			"| `SAMPLE_CODE` | `NVARCHAR(50)` | NOT NULL | Client link |",
			"| `REMOVED_COL` | `NVARCHAR(30)` | NULL | Keep untouched when requested |",
			"",
		].join("\n");

		const tables = parseCreateTables(ddl, { includeStandaloneAlter: true });

		const kept = mergeSqlTablesIntoMarkdown(existingMd, tables, "schema/database/sample_batch.sql", { markDropped: false });
		expect(kept.text).toContain("`REMOVED_COL`");
		expect(kept.text).toContain("Keep untouched when requested");
		expect(kept.text).not.toContain("[deprecated / dropped in SQL]");
		expect(kept.text).toContain("Custom analyst note");
		expect(kept.text).toContain("`STATUS_FLAG`");

		const marked = mergeSqlTablesIntoMarkdown(existingMd, tables, "schema/database/sample_batch.sql", { markDropped: true });
		expect(marked.text).toContain("`REMOVED_COL`");
		expect(marked.text).toContain("[deprecated / dropped in SQL]");
		expect(marked.text).toContain("Custom analyst note");
	});
});

describe("Round 6 Wave 1.5 — Unified rename link-healing contracts", () => {
	test("plan model preserves built.units[].script, built.tests.script, scripts[], and testScripts[] cleanly", () => {
		expect(isPlanPath("/ws/design/SampleFlow.plan.json")).toBe(true);
		const raw = JSON.stringify(
			{
				version: 1,
				title: "Sample Flow",
				groups: [],
				nodes: [{ id: "n1", kind: "step", text: "Validate", docs: ["docs/specs/Old Spec.md"] }],
				edges: [],
				targets: ["src/OldScript.ssl"],
				scripts: ["src/OldScript.ssl"],
				testScripts: ["tests/OldScript.test.ssl"],
				built: {
					units: [{ id: "u1", script: "src/OldScript.ssl", nodes: ["n1"] }],
					tests: { script: "tests/OldScript.test.ssl" },
				},
			},
			null,
			2,
		);
		const parsed = parsePlan(raw);
		expect(parsed.plan).toBeDefined();
		if (!parsed.plan) return;
		const plan = parsed.plan;
		// Verify no %20 corruption when rewriting raw paths in plan JSON
		plan.nodes[0]!.docs = ["docs/specs/New Spec.md"];
		plan.targets = ["src/NewScript.ssl"];
		plan.scripts = ["src/NewScript.ssl"];
		plan.testScripts = ["tests/NewScript.test.ssl"];
		const built = plan.built as { units: { script: string }[]; tests: { script: string } };
		built.units[0]!.script = "src/NewScript.ssl";
		built.tests.script = "tests/NewScript.test.ssl";
		const printed = printPlan(plan);
		expect(printed).toContain("docs/specs/New Spec.md");
		expect(printed).not.toContain("%20");
		expect(printed).toContain("src/NewScript.ssl");
		expect(printed).toContain("tests/NewScript.test.ssl");
	});

	test("withLinkFiles and withNames rewrite only matched paths/wikilinks without touching surrounding prose", () => {
		const md = "See [Spec](../specs/old-spec.md#overview) and [[Old Note#Section|Display Label]].\n";
		const pathFix = withLinkFiles(md, [
			{ line: 1, column: md.indexOf("../specs/old-spec.md"), href: "../specs/old-spec.md#overview", instead: "../specs/new-spec.md" },
		]);
		expect(pathFix.done).toBe(1);
		expect(pathFix.text).toContain("[Spec](../specs/new-spec.md#overview)");
		expect(pathFix.text).toContain("[[Old Note#Section|Display Label]]");

		const wikiFix = withNames(pathFix.text, [
			{ line: 1, column: pathFix.text.indexOf("Old Note"), name: "Old Note", instead: "New Note" },
		]);
		expect(wikiFix.done).toBe(1);
		expect(wikiFix.text).toBe("See [Spec](../specs/new-spec.md#overview) and [[New Note#Section|Display Label]].\n");
	});
});

describe("Round 6 Waves 3.1 & 3.2 — Governance approvals & IQ/OQ/PQ Test Execution Protocols", () => {
	test("controlled doc approval metadata clears staleDocChecks and satisfies ADR 0008 Revision History table rules", () => {
		const unapproved = sampleDoc({
			path: "/ws/docs/specs/SOP-001.md",
			name: "SOP-001.md",
			group: "specs",
			title: "Sample Reception SOP",
			status: "review",
			version: "1.0",
			changeControl: "CC-2026-014",
			gxpImpact: "high",
		});

		const beforeIssues = staleDocChecks([unapproved], Date.UTC(2026, 10, 20));
		const approvalIssue = beforeIssues.find((i) => i.fix?.kind === "record-approval");
		expect(approvalIssue).toBeDefined();
		expect(approvalIssue?.fix).toEqual({ kind: "record-approval", path: unapproved.path });

		// Simulate stamping approval frontmatter + 4-column Revision History row
		let text = [
			"---",
			"title: Sample Reception SOP",
			"status: review",
			"version: 1.0",
			"change-control: CC-2026-014",
			"gxp-impact: high",
			"---",
			"",
			"# Sample Reception SOP",
			"",
			"## Revision History",
			"",
			"| Version | Date | Author | Summary |",
			"| --- | --- | --- | --- |",
			"| 1.0 | 2026-10-01 | QA Reviewer | Initial draft |",
			"",
		].join("\n");

		text = withFrontMatter(text, "status", frontValue("approved"))!;
		text = withFrontMatter(text, "version", frontValue("1.1"))!;
		text = withFrontMatter(text, "approved-by", frontValue("QA Lead"))!;
		text = withFrontMatter(text, "approved-date", "2026-11-20")!;
		text = withFrontMatter(text, "effective-date", "2026-11-20")!;
		text = withFrontMatter(text, "review-due", "2027-11-20")!;
		text += "| 1.1 | 2026-11-20 | QA Lead | Approved for QA validation |\n";

		const fm = frontMatter(text);
		expect(one(fm.values.status)).toBe("approved");
		expect(one(fm.values["approved-by"])).toBe("QA Lead");
		expect(one(fm.values["approved-date"])).toBe("2026-11-20");
		expect(one(fm.values["effective-date"])).toBe("2026-11-20");
		expect(one(fm.values["review-due"])).toBe("2027-11-20");
		expect(checkTables(text)).toHaveLength(0);

		const approvedDoc = sampleDoc({
			...unapproved,
			status: "approved",
			version: "1.1",
			approvedBy: "QA Lead",
			approvedDate: "2026-11-20",
			effectiveDate: "2026-11-20",
			reviewDue: "2027-11-20",
		});
		const afterIssues = staleDocChecks([approvedDoc], Date.UTC(2026, 10, 20));
		expect(afterIssues.find((i) => i.fix?.kind === "record-approval")).toBeUndefined();
	});

	test("assembleTestExecutionProtocol and parseTestRunDocument round-trip with staleness & readiness integration", () => {
		const protocolMd = assembleTestExecutionProtocol({
			ticketKey: "LIMS-204",
			ticketTitle: "Validate sample login barcode rule",
			phase: "OQ",
			environment: "QA",
			gitSha: "abc1234567890",
			executedBy: "Validation Analyst",
			executedDate: "2026-11-20",
			projectName: "LabCore",
			changeControl: "CC-2026-088",
			planTests: [{ name: "Reject malformed barcode", given: "Invalid prefix", expect: "Returns error code E101" }],
			checklistItems: ["Barcode length check rejects < 6 chars"],
			testScripts: ["tests/ValidateBarcode.test.ssl"],
		});

		expect(protocolMd).toContain("type: test-run");
		expect(protocolMd).toContain("ticket: LIMS-204");
		expect(protocolMd).toContain("phase: OQ");
		expect(protocolMd).toContain("environment: QA");
		expect(protocolMd).toContain("git-sha: abc1234567890");
		expect(checkTables(protocolMd)).toHaveLength(0);

		// Mark protocol as passing after execution
		const passingMd = withFrontMatter(protocolMd, "result", "pass")!;
		const run = parseTestRunDocument("/ws/docs/tickets/LIMS-204/test-runs/2026-11-20-qa-oq.md", passingMd);
		expect(run).not.toBeNull();
		expect(run!.ticket).toBe("LIMS-204");
		expect(run!.phase).toBe("OQ");
		expect(run!.environment).toBe("QA");
		expect(run!.result).toBe("pass");
		expect(isTestRunStale(run!, "abc1234")).toBe(false);
		expect(isTestRunStale(run!, "def9999")).toBe(true);

		const ticket = sampleDoc({
			path: "/ws/docs/tickets/LIMS-204.md",
			name: "LIMS-204.md",
			ticket: "LIMS-204",
			title: "Validate sample login barcode rule",
			status: "review",
			tasks: { done: 2, total: 2 },
			specs: ["docs/specs/barcode.md"],
		});
		const spec = sampleDoc({
			path: "/ws/docs/specs/barcode.md",
			name: "barcode.md",
			group: "specs",
			title: "Barcode Spec",
			status: "approved",
			tickets: ["LIMS-204"],
		});
		const ticketBody = "# LIMS-204\n\n## Rollback\n\nRestore previous ValidateBarcode.ssl.\n";

		const freshReady = evaluateTicketReadiness([ticket, spec], "LIMS-204", {
			testRuns: [run!],
			currentGitSha: "abc1234567890",
		});
		expect(freshReady).not.toBeNull();
		expect(freshReady!.checks.some((c) => c.ok && c.level === "pass" && /test|validation|OQ|QA/i.test(c.label + " " + c.detail))).toBe(true);

		const staleReady = evaluateTicketReadiness([ticket, spec], "LIMS-204", {
			testRuns: [run!],
			currentGitSha: "ff00aa1122334",
		});
		expect(staleReady).not.toBeNull();
		expect(staleReady!.checks.some((c) => !c.ok && c.level === "warn" && /stale|sha|commit/i.test(c.label + " " + c.detail))).toBe(true);

		const failingRun = { ...run!, result: "fail" as const };
		const failReady = evaluateTicketReadiness([ticket, spec], "LIMS-204", {
			testRuns: [failingRun],
			currentGitSha: "abc1234567890",
		});
		expect(failReady).not.toBeNull();
		expect(failReady!.ready).toBe(false);
		expect(failReady!.checks.some((c) => !c.ok && /fail|test|validation/i.test(c.label + " " + c.detail))).toBe(true);

		// Ticket Packet and RTM both surface testRuns + staleness
		const packetMd = assembleTicketPacketMarkdown({
			projectName: "LabCore",
			ticketKey: "LIMS-204",
			ticketTitle: "Validate sample login barcode rule",
			ticketBody,
			generatedOn: "2026-11-20",
			currentGitSha: "ff00aa1122334",
			testRuns: [run!],
			specs: [],
			plans: [],
			decisions: [],
			questions: [],
			schemas: [],
			registries: [],
			ticketFiles: [],
		});
		expect(packetMd).toContain("OQ");
		expect(packetMd).toContain("QA");
		expect(packetMd).toMatch(/stale/i);

		const rtmRows = buildRtmRows({
			docs: [ticket, spec],
			testRuns: [run!],
			currentGitSha: "abc1234567890",
		});
		expect(rtmRows).toHaveLength(1);
		expect(rtmRows[0]!.validationStatus).toMatch(/pass/i);
		expect(rtmRows[0]!.validationStale).toBe(false);
		const rtmMd = assembleRtmMarkdown(rtmRows, "LabCore");
		const rtmCsv = assembleRtmCsv(rtmRows);
		expect(rtmMd).toContain("LIMS-204");
		expect(rtmCsv).toContain("LIMS-204");
	});
});

describe("Round 6 Waves 3.2 & 3.3 — Deployment Runbooks & Release Bundle parity", () => {
	test("orderSqlTablesTopologically orders parent before child and tolerates cycles", () => {
		const ordered = orderSqlTablesTopologically([
			{ name: "ORDER_LINE", dependsOn: ["ORDER_HEADER", "PRODUCT"] },
			{ name: "ORDER_HEADER", dependsOn: ["CUSTOMER"] },
			{ name: "CUSTOMER" },
			{ name: "PRODUCT" },
		]);
		expect(ordered.indexOf("CUSTOMER")).toBeLessThan(ordered.indexOf("ORDER_HEADER"));
		expect(ordered.indexOf("ORDER_HEADER")).toBeLessThan(ordered.indexOf("ORDER_LINE"));
		expect(ordered.indexOf("PRODUCT")).toBeLessThan(ordered.indexOf("ORDER_LINE"));

		const cyclic = orderSqlTablesTopologically([
			{ name: "NODE_A", dependsOn: ["NODE_B"] },
			{ name: "NODE_B", dependsOn: ["NODE_A"] },
		]);
		expect(cyclic).toHaveLength(2);
		expect(cyclic).toContain("NODE_A");
		expect(cyclic).toContain("NODE_B");
	});

	test("detectChecksumDrift flags verified manifest rows whose live SHA-256 changed", () => {
		const drifts = detectChecksumDrift(
			[
				{ path: "src/Validate.ssl", sha256: "aaaa1111", status: "verified" },
				{ path: "src/Unchanged.ssl", sha256: "bbbb2222", status: "verified" },
				{ path: "src/Draft.ssl", sha256: "cccc3333", status: "draft" },
			],
			[
				{ path: "src/Validate.ssl", sha256: "9999ffff" },
				{ path: "src/Unchanged.ssl", sha256: "bbbb2222" },
				{ path: "src/Draft.ssl", sha256: "dddd4444" },
			],
		);
		expect(drifts).toHaveLength(1);
		expect(drifts[0]!.path).toBe("src/Validate.ssl");
		expect(drifts[0]!.expectedSha256).toBe("aaaa1111");
		expect(drifts[0]!.actualSha256).toBe("9999ffff");
	});

	test("assembleDeploymentRunbook, Deployment Manifest, and Release Bundle (MD + CSV) wire checksums, planTests, and runbook", () => {
		const runbookInput = {
			jobs: [{ name: "NightlySampleSync", schedule: "0 2 * * *", calls: "src/SampleSync.ssl", status: "active" }],
			sqlTables: [
				{ name: "BATCH_ITEM", dependsOn: ["BATCH_HEADER"], path: "schema/batch_item.sql" },
				{ name: "BATCH_HEADER", path: "schema/batch_header.sql" },
			],
			scripts: [{ ref: "src/SampleSync.ssl", kind: "Server Script", ticket: "LIMS-301" }],
			settings: [{ name: "BATCH_TIMEOUT_SEC", value: "120", where: "Global", status: "active" }],
			interfaces: [{ name: "ERP_OUTBOUND", direction: "outbound", how: "HL7", status: "agreed" }],
			checksumDrifts: [{ path: "src/SampleSync.ssl", expectedSha256: "1111", actualSha256: "2222", status: "verified" }],
		};

		const runbookMd = assembleDeploymentRunbook(runbookInput);
		expect(runbookMd).toContain("NightlySampleSync");
		expect(runbookMd.indexOf("BATCH_HEADER")).toBeLessThan(runbookMd.indexOf("BATCH_ITEM"));
		expect(runbookMd).toContain("src/SampleSync.ssl");
		expect(runbookMd).toMatch(/drift|checksum/i);

		const manifestMd = assembleDeploymentManifestMarkdown({
			projectName: "LabCore",
			ticketKey: "LIMS-301",
			ticketTitle: "Nightly batch sync",
			scopeTickets: [{ key: "LIMS-301", title: "Nightly batch sync", status: "review" }],
			generatedOn: "2026-11-20",
			headSha: "a1b2c3d",
			scripts: runbookInput.scripts,
			sqlArtifacts: [{ path: "schema/batch_header.sql", kind: "SQL DDL", source: "Schema", ticket: "LIMS-301" }],
			registries: [],
			checksums: [{ path: "src/SampleSync.ssl", sha256: "2222" }],
			runbook: runbookInput,
		});
		expect(manifestMd).toContain("NightlySampleSync");
		expect(manifestMd).toContain("2222");

		const bundleInput = {
			projectName: "LabCore",
			releaseName: "R2026.12",
			generatedOn: "2026-11-20",
			headSha: "a1b2c3d",
			tickets: [
				{
					key: "LIMS-301",
					title: "Nightly batch sync",
					status: "review",
					release: "R2026.12",
					changeControl: "CC-2026-099",
				},
			],
			scripts: runbookInput.scripts,
			planTests: [{ plan: "SampleSync", name: "Retries transient lock", expect: "Succeeds on retry 2", ticket: "LIMS-301" }],
			sqlArtifacts: [{ path: "schema/batch_header.sql", kind: "SQL DDL", source: "Schema", ticket: "LIMS-301" }],
			registries: [],
			checksums: [{ path: "src/SampleSync.ssl", sha256: "2222" }],
			runbook: runbookInput,
		};
		const bundleMd = assembleReleaseBundleMarkdown(bundleInput);
		expect(bundleMd).toContain("R2026.12");
		expect(bundleMd).toContain("Retries transient lock");
		expect(bundleMd).toContain("NightlySampleSync");
		expect(bundleMd).toContain("2222");

		const bundleCsv = assembleReleaseBundleCsv(bundleInput);
		expect(bundleCsv).toContain("Release,Category,Artifact,Tickets,Status,SHA-256,Notes");
		expect(bundleCsv).toContain("LIMS-301");
		expect(bundleCsv).toContain("R2026.12");
		expect(bundleCsv).toContain("2222");
		expect(bundleCsv).toContain("Retries transient lock");
	});
});

describe("Round 6 Wave 3.5 — Health 1-click fixes & Docs bulk frontmatter helpers", () => {
	test("docChecks emits mend-wikilinks and reciprocal-adr fixes that resolve cleanly when applied", () => {
		const line3 = "See [[Old Spec#Goals|Spec]] for details.";
		const noteText = `# Notes\n\n${line3}\n`;
		const col = line3.indexOf("Old Spec");
		const noteDoc = sampleDoc({
			path: "/ws/docs/notes.md",
			name: "notes.md",
			group: "docs",
			title: "Notes",
			broken: [{ href: "[[Old Spec]]", line: 3, column: col, instead: "New Spec" }],
		});
		const adr1 = sampleDoc({
			path: "/ws/docs/knowledge/decisions/0001-legacy.md",
			name: "0001-legacy.md",
			group: "knowledge",
			kind: "decisions",
			title: "Legacy Choice",
			status: "superseded",
		});
		const adr2 = sampleDoc({
			path: "/ws/docs/knowledge/decisions/0002-modern.md",
			name: "0002-modern.md",
			group: "knowledge",
			kind: "decisions",
			title: "Modern Choice",
			status: "decided",
			supersedes: ["0001-legacy"],
		});

		const checks = docChecks([noteDoc, adr1, adr2], []);
		const wikiCheck = checks.find((c) => c.fix?.kind === "mend-wikilinks");
		expect(wikiCheck).toBeDefined();
		if (wikiCheck?.fix?.kind === "mend-wikilinks") {
			const mended = withNames(noteText, wikiCheck.fix.mends);
			expect(mended.done).toBe(1);
			expect(mended.text).toBe("# Notes\n\nSee [[New Spec#Goals|Spec]] for details.\n");
		}

		const adrCheck = checks.find((c) => c.fix?.kind === "reciprocal-adr");
		expect(adrCheck).toBeDefined();
		expect(adrCheck?.fix).toEqual({
			kind: "reciprocal-adr",
			path: adr1.path,
			field: "superseded-by",
			value: "0002-modern",
		});

		// Applying reciprocal-adr fix via frontmatter helper
		const adr1Text = "---\ntitle: Legacy Choice\nstatus: superseded\n---\n\n# Legacy Choice\n";
		if (adrCheck?.fix?.kind === "reciprocal-adr") {
			const updated = withFrontMatter(adr1Text, adrCheck.fix.field, frontValue(adrCheck.fix.value))!;
			expect(one(frontMatter(updated).values["superseded-by"])).toBe("0002-modern");
			// Adding a second reciprocal value switches cleanly to list syntax
			const updatedList = addToFrontMatterList(updated, adrCheck.fix.field, "0003-followup")!;
			expect(updatedList).toContain("0002-modern");
			expect(updatedList).toContain("0003-followup");
		}
	});

	test("bulk status quoting & answered-date stamping for questions", () => {
		const qText = "---\ntitle: Which barcode format?\nstatus: open\n---\n\n# Which barcode format?\n";
		const statusVal = "answered";
		let next = withFrontMatter(qText, "status", frontValue(statusVal))!;
		expect(toneOf(statusVal)).toBe("done");
		if (!one(frontMatter(next).values.answered)) {
			next = withFrontMatter(next, "answered", "2026-11-20")!;
		}
		expect(one(frontMatter(next).values.status)).toBe("answered");
		expect(one(frontMatter(next).values.answered)).toBe("2026-11-20");

		// Scalar containing YAML-special chars is safely quoted by frontValue
		const relUpdated = withFrontMatter(next, "release", frontValue("R2026:12 #rc1"))!;
		expect(one(frontMatter(relUpdated).values.release)).toBe("R2026:12 #rc1");
	});
});
