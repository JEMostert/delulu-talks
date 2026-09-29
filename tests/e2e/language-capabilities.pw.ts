import { expect, test } from "@playwright/test";
import { LANGUAGES } from "../../src/data";

for (const model of ["r2t2", "r2t2Mlx"]) {
  test(`${model} language selection stays explicit and shared across Controls and Settings`, async ({
    page,
  }) => {
    await page.addInitScript((model) => {
      if (!localStorage.getItem("delulu-demo-settings"))
        localStorage.setItem(
          "delulu-demo-settings",
          JSON.stringify({ onboardingComplete: true, model, language: "nl" }),
        );
    }, model);
    await page.goto("/");
    const home = page.getByRole("combobox", { name: "Dictation language" });
    await expect(home).toBeEnabled();
    await expect(home).toHaveValue("nl");
    const homeChoices = await home.locator("option").evaluateAll((options) =>
      options.map((option) => ({
        value: (option as HTMLOptionElement).value,
        label: option.textContent,
      })),
    );
    expect(homeChoices).toEqual(
      LANGUAGES.map(([value, label]) => ({ value, label })),
    );
    await home.selectOption("de");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("delulu-demo-settings") ?? "{}")
              .language,
        ),
      )
      .toBe("de");
    await expect(home).toHaveValue("de");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const settings = page.getByRole("combobox", {
      name: "Language",
      exact: true,
    });
    await expect(settings).toBeEnabled();
    await expect(settings).toHaveValue("de");
    const settingsChoices = await settings
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => ({
          value: (option as HTMLOptionElement).value,
          label: option.textContent,
        })),
      );
    expect(settingsChoices).toEqual(homeChoices);
    await settings.selectOption("fr");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("delulu-demo-settings") ?? "{}")
              .language,
        ),
      )
      .toBe("fr");
    await expect(settings).toHaveValue("fr");
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Dictation language" }),
    ).toHaveValue("fr");
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("delulu-demo-settings") ?? "{}")
            .model,
      ),
    ).toBe(model);
  });
}
